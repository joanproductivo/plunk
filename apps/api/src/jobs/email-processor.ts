/**
 * Background Job: Email Processor
 * Processes individual emails from the queue (for all sources: transactional, campaign, workflow)
 *
 * This is the only send path. `EmailService.sendEmail` used to hold a second copy of it, tested
 * while this one was not, and the two had drifted; it has been removed. The job body is
 * `processEmailJob`, exported so the tests drive the code the worker runs.
 *
 * Retries: an attempt that fails before SES accepts the email puts it back to PENDING and lets
 * BullMQ retry it; only the last attempt marks it FAILED. Once SES has accepted it, the email is
 * never sent again and never marked FAILED: what SES returned is kept on the job, and a retry
 * only records the send.
 */

import {CampaignStatus, EmailStatus, Prisma, WorkflowExecutionStatus} from '@plunk/db';
import {isMailboxSimulatorAddress} from '@plunk/shared';
import type {AcceptedEmail, SendEmailJobData} from '@plunk/types';
import {type Job, UnrecoverableError, Worker} from 'bullmq';
import signale from 'signale';

import {
  DASHBOARD_URI,
  EMAIL_RATE_LIMIT_PER_SECOND,
  EMAIL_WORKER_CONCURRENCY,
  EMAIL_WORKER_MAX_CONCURRENCY,
} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {CampaignService} from '../services/CampaignService.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {
  bodyHasListManagementLink,
  buildEmailHeaders,
  classifyEmail,
  RECIPIENT_OVERRIDE_HEADER,
  recipientAddress,
  withSourceEmail,
} from '../services/EmailHeaderService.js';
import {EmailService, POSSIBLY_SENT_NOTE} from '../services/EmailService.js';
import {EventService} from '../services/EventService.js';
import {MeterService} from '../services/MeterService.js';
import {ProjectFooterService} from '../services/ProjectFooterService.js';
import {emailQueue} from '../services/QueueService.js';
import {SecurityService} from '../services/SecurityService.js';
import {SuppressionService} from '../services/SuppressionService.js';
import {getSendingQuota, safeToRetrySend, sendRawEmail} from '../services/SESService.js';

/**
 * Determine the email sending rate limit (emails per second)
 * Priority: ENV variable > AWS SES quota > Safe default (14)
 */
async function getEmailRateLimit(): Promise<number> {
  const DEFAULT_RATE_LIMIT = 14; // AWS SES sandbox limit - safe default

  // If env variable is set, use it (override)
  if (EMAIL_RATE_LIMIT_PER_SECOND !== undefined) {
    signale.info(`[EMAIL-PROCESSOR] Using rate limit from environment: ${EMAIL_RATE_LIMIT_PER_SECOND} emails/second`);
    return EMAIL_RATE_LIMIT_PER_SECOND;
  }

  // Try to fetch from AWS SES
  signale.info('[EMAIL-PROCESSOR] Fetching rate limit from AWS SES...');
  const quota = await getSendingQuota();

  if (quota) {
    signale.info(
      `[EMAIL-PROCESSOR] AWS SES quota: ${quota.maxSendRate} emails/second (${quota.sentLast24Hours}/${quota.max24HourSend} emails sent today)`,
    );
    return quota.maxSendRate;
  }

  // Fallback to safe default
  signale.warn(`[EMAIL-PROCESSOR] Failed to fetch AWS quota, using safe default: ${DEFAULT_RATE_LIMIT} emails/second`);
  return DEFAULT_RATE_LIMIT;
}

/**
 * Derive worker concurrency from the rate limit so a higher SES quota actually
 * translates into higher throughput. The mean job duration is ~0.5s (Prisma
 * reads + HTML compile + SES call + writes), so `rate * 0.5` gives ~2× headroom
 * over the per-second cap. Clamped to keep sandbox accounts useful and to
 * protect the Prisma pool on very large quotas.
 */
function deriveWorkerConcurrency(rateLimit: number): number {
  if (EMAIL_WORKER_CONCURRENCY !== undefined) {
    return EMAIL_WORKER_CONCURRENCY;
  }

  const TARGET_JOB_SECONDS = 0.5;
  const MIN_CONCURRENCY = 5;
  const derived = Math.ceil(rateLimit * TARGET_JOB_SECONDS);
  return Math.max(MIN_CONCURRENCY, Math.min(derived, EMAIL_WORKER_MAX_CONCURRENCY));
}

const EMAIL_INCLUDE = {
  contact: true,
  project: true,
  template: {select: {type: true}},
  campaign: {select: {type: true, status: true, name: true, sentAt: true}},
  workflowExecution: {select: {status: true, exitReason: true}},
} satisfies Prisma.EmailInclude;

type EmailToSend = Prisma.EmailGetPayload<{include: typeof EMAIL_INCLUDE}>;

/** What `processEmailJob` uses of a BullMQ job, so tests can drive it without a queue */
export type EmailJob = Pick<Job<SendEmailJobData>, 'data' | 'attemptsMade' | 'opts' | 'updateData'>;

/**
 * Finalize a campaign whose email has just reached a terminal state, without letting a failure
 * here fail the job that got it there
 */
export async function finalizeCampaignSafely(campaignId: string | null): Promise<void> {
  if (!campaignId) {
    return;
  }

  try {
    await CampaignService.finalizeIfDone(campaignId);
  } catch (error) {
    signale.error(`[EMAIL-PROCESSOR] Failed to finalize campaign ${campaignId}:`, error);
  }
}

/**
 * Record an email SES has accepted, and everything that follows from it.
 *
 * Runs again on a retry that finds `accepted` on the job, so it must be safe to repeat: the
 * stamp is guarded on `sentAt` still being null, and only the run that stamped it counts the
 * send, bills it and tracks `email.sent`.
 */
async function recordSent(email: EmailToSend, accepted: AcceptedEmail, recipientEmail: string): Promise<void> {
  // Mark as sent with SES message ID.
  //
  // Guarded on `sentAt` still being null so the campaign counter below is only
  // incremented by the run that actually stamped it. A job retried after SES
  // accepted the message would otherwise count the same email twice.
  const marked = await prisma.email.updateMany({
    where: {id: email.id, sentAt: null},
    data: {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      messageId: accepted.messageId,
      // Stamped here, and only here, because this is the one place that knows the
      // address SES was actually given -- `recipientEmail`, which is the override header
      // when one is set and the contact's address otherwise. The send path is also the
      // only moment the answer can still change: an email that was never handed to SES
      // cannot bounce, so a row that never reaches this update has nothing to exclude.
      // Folded into the existing update rather than written separately, so it costs no
      // extra query per send.
      simulated: isMailboxSimulatorAddress(recipientEmail),
    },
  });

  // Zero rows means another run already stamped this email -- SES accepted the
  // message, then the job was retried. Everything below sends a second signal
  // for one delivery (a duplicate `email.sent` re-triggers workflows), so stop
  // here rather than replaying it. Finalization still runs: this email is
  // terminal either way, and the campaign must not be left stuck in SENDING.
  if (marked.count === 0) {
    signale.warn(`[EMAIL-PROCESSOR] Email ${email.id} was already marked sent, skipping duplicate side effects`);
    await finalizeCampaignSafely(email.campaignId);
    return;
  }

  if (email.campaignId) {
    await CampaignService.countCampaignSent(email.campaignId);
  }

  // Record usage for billing (pay-per-email)
  // Uses email ID as idempotency key to prevent double-charging on retries
  // Charge 2 emails if attachments are present
  if (email.project.customer) {
    const hasAttachments = email.attachments && Array.isArray(email.attachments) && email.attachments.length > 0;
    const emailCount = hasAttachments ? 2 : 1;
    await MeterService.recordEmailSent(email.project.customer, emailCount, `email_${email.id}`);
  }

  // Track event (this will trigger workflows)
  await EventService.trackEvent(email.projectId, 'email.sent', email.contactId, email.id, {
    subject: accepted.subject,
    from: email.from,
    fromName: email.fromName,
    messageId: accepted.messageId,
    emailId: email.id,
    templateId: email.templateId,
    campaignId: email.campaignId,
    sourceType: email.sourceType,
    sentAt: new Date().toISOString(),
  });

  if (email.campaignId) {
    await CampaignService.finalizeIfDone(email.campaignId);
  }
}

/**
 * An email whose job ran out of attempts while it was still PENDING: the attempts failed
 * before the send began (reading the row, the footers), so nothing marked it. Without this it
 * would stay PENDING for good and hold its campaign in SENDING. A SENDING row is left alone,
 * because SES may have it.
 */
export async function failAbandonedEmail(emailId: string): Promise<void> {
  try {
    const failed = await prisma.email.updateMany({
      where: {id: emailId, status: EmailStatus.PENDING},
      data: {status: EmailStatus.FAILED, error: 'Could not be sent after every retry'},
    });

    if (failed.count > 0) {
      const email = await prisma.email.findUnique({
        where: {id: emailId},
        include: {contact: {select: {email: true}}, campaign: {select: {name: true}}},
      });

      if (email) {
        await FailureAlertService.recordEmail(email, 'Could not be sent after every retry');
        await finalizeCampaignSafely(email.campaignId);
      }
    }
  } catch (error) {
    signale.error(`[EMAIL-PROCESSOR] Failed to mark abandoned email ${emailId} as failed:`, error);
  }
}

export async function processEmailJob(job: EmailJob): Promise<void> {
  const {emailId} = job.data;

  const email = await prisma.email.findUnique({
    where: {id: emailId},
    include: EMAIL_INCLUDE,
  });

  // A missing row is now an expected outcome rather than an error: cancelling a
  // campaign before it sent anything deletes its unsent emails in the background,
  // and every job already queued for them arrives here to find nothing. Throwing
  // would put each one through three retries and into the failed set -- millions
  // of executions for a large campaign, burying real failures. There is nothing to
  // send and nothing to record, so the job is simply done.
  if (!email) {
    signale.warn(`[EMAIL-PROCESSOR] Email ${emailId} no longer exists, skipping`);
    return;
  }

  // Parse custom headers from JSON
  const customHeaders =
    email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers)
      ? (email.headers as Record<string, string>)
      : undefined;

  // Check for custom recipient override in headers
  const recipientEmail = recipientAddress(email.headers, email.contact.email);

  // SES accepted this email on an earlier attempt and recording the send failed. The row is
  // still SENDING, so the check below would skip it and leave it without its messageId --
  // and a bounce or complaint for it could then never be matched. Record it, never resend.
  if (job.data.accepted) {
    await recordSent(email, job.data.accepted, recipientEmail);
    return;
  }

  if (email.status !== EmailStatus.PENDING) {
    return;
  }

  // A campaign that was cancelled (or reverted to draft) after this job was
  // queued must not keep sending. `CampaignService.processBatch` stops the batch
  // chain on its own status check, but the per-email jobs it already created are
  // in this queue and would otherwise ship regardless -- which is what made a
  // cancel of a SENDING campaign a relabel rather than a stop. Marking the email
  // FAILED rather than deleting it keeps the row that `cancel` counts when it
  // decides whether the campaign is still reversible.
  if (email.campaign && email.campaign.status !== CampaignStatus.SENDING) {
    signale.warn(
      `[EMAIL-PROCESSOR] Campaign ${email.campaignId} is ${email.campaign.status}, skipping email ${emailId}`,
    );
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: `Campaign ${email.campaign.status.toLowerCase()}`,
      },
    });

    // No `finalizeIfDone` here: it only advances a campaign that is still
    // SENDING, and this branch runs precisely when it is not.
    return;
  }

  // An email of an earlier send of this campaign must not go out with this one. Every email of
  // the current send carries the id derived from it. None should get here: `processBatch`
  // creates each email under a lock that re-checks the send, and a cancelled campaign goes back
  // to a draft only once it has no emails left. This stays as the last guard against mailing
  // the audience twice; should one ever get here, it is still counted by finalization (FAILED)
  // and by the last batch's total, which can close the current send early or never.
  if (
    email.campaign &&
    email.campaignId &&
    (!email.campaign.sentAt ||
      email.id !== CampaignService.emailIdFor(email.campaignId, email.campaign.sentAt.getTime(), email.contactId))
  ) {
    signale.warn(
      `[EMAIL-PROCESSOR] Email ${emailId} belongs to an earlier send of campaign ${email.campaignId}, skipping`,
    );
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: 'Stale campaign generation',
      },
    });
    // No finalization: this email is not part of the current send, and finalizing on its
    // account could close a send that has not created its own emails yet
    return;
  }

  // Check if project is disabled
  if (email.project.disabled) {
    signale.warn(`[EMAIL-PROCESSOR] Project ${email.projectId} is disabled, cancelling email ${emailId}`);
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: 'Project is disabled',
      },
    });

    // Cancelled emails are terminal for the campaign — finalize so it doesn't
    // stay stuck in SENDING forever waiting on emails that will never be sent.
    if (email.campaignId) {
      await CampaignService.finalizeIfDone(email.campaignId);
    }
    return;
  }

  // Plunk Lite: an email of a workflow run cancelled since it was queued -- by hand, all at once,
  // by the workflow's brake for its bounces or complaints, or with its project -- is not sent: a
  // step that was running when the run was cancelled can create one after the cancel cleared the rest
  if (email.workflowExecution?.status === WorkflowExecutionStatus.CANCELLED) {
    signale.info(`[EMAIL-PROCESSOR] Workflow run of email ${emailId} was cancelled, skipping it`);
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: email.workflowExecution.exitReason ?? 'Workflow run cancelled',
      },
    });
    return;
  }

  // Queued while subscribed, but unsubscribed, bounced or complained since. The same rule
  // decided whether the email could be queued at all.
  if (
    !email.contact.subscribed &&
    EmailService.requiresSubscribedContact({
      sourceType: email.sourceType,
      templateType: email.template?.type,
      hasRecipientOverride: Boolean(customHeaders?.[RECIPIENT_OVERRIDE_HEADER]),
    })
  ) {
    signale.info(`[EMAIL-PROCESSOR] Contact ${email.contactId} is unsubscribed, skipping email ${emailId}`);
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: 'Contact is unsubscribed',
      },
    });

    await finalizeCampaignSafely(email.campaignId);
    return;
  }

  // An address on the project's suppression list is never sent to, transactional email
  // included: it bounced for good or reported mail as spam, and SES would only bounce it again.
  // This is the last gate whatever subscribed the contact meanwhile.
  const suppression = await SuppressionService.find(email.projectId, recipientEmail);
  if (suppression) {
    signale.info(`[EMAIL-PROCESSOR] ${recipientEmail} is suppressed, skipping email ${emailId}`);
    await prisma.email.updateMany({
      where: {id: emailId, status: EmailStatus.PENDING},
      data: {
        status: EmailStatus.FAILED,
        error: `Address is suppressed after a ${suppression.reason === 'COMPLAINT' ? 'complaint' : 'bounce'}`,
      },
    });

    await finalizeCampaignSafely(email.campaignId);
    return;
  }

  // Classify the email once: it decides both the unsubscribe footer and the
  // standards-based headers below.
  const emailClass = classifyEmail({
    sourceType: email.sourceType,
    templateType: email.template?.type,
    campaignType: email.campaign?.type,
  });

  // The project's own unsubscribe footers, read while the email is still pending: a failed
  // read fails this attempt before the email is marked, so BullMQ's retry sends it, rather
  // than it going out without the project's footer.
  const footers = await ProjectFooterService.forEmail(emailClass, email.projectId);

  // Set once SES has the email: a failure after that (counters, billing, events) does not
  // mean the email was not sent, so it is never marked failed and never sent again.
  let accepted: AcceptedEmail | undefined;
  // The phishing check disables the project, which reports the failure itself
  let disabledForPolicy = false;
  // Set just before the email is handed to SES: from then on, a failure that is not an answer
  // from SES leaves it unknown whether SES took the email
  let handedToSes = false;

  try {
    // Claim the email: only the run that moves it from PENDING sends it. A job BullMQ
    // re-runs as stalled while the first run is still going (Redis unreachable long enough
    // to lose the lock) finds it taken.
    const claimed = await prisma.email.updateMany({
      where: {id: emailId, status: EmailStatus.PENDING},
      data: {status: EmailStatus.SENDING},
    });

    if (claimed.count === 0) {
      return;
    }

    // Format template variables in subject and body
    const contactData = (email.contact.data as Record<string, unknown>) || {};
    const formattedEmail = EmailService.format({
      subject: email.subject,
      body: email.body,
      data: {
        email: email.contact.email,
        ...contactData,
        data: contactData,
        unsubscribeUrl: withSourceEmail(`${DASHBOARD_URI}/unsubscribe/${email.contact.id}`, emailId),
        subscribeUrl: withSourceEmail(`${DASHBOARD_URI}/subscribe/${email.contact.id}`, emailId),
        manageUrl: withSourceEmail(`${DASHBOARD_URI}/manage/${email.contact.id}`, emailId),
      },
    });

    // Compile HTML with unsubscribe footer and badge.
    // Only marketing emails get the unsubscribe footer: the project's own, or Plunk's.
    const compiledHtml = EmailService.compile({
      content: formattedEmail.body,
      contact: email.contact,
      project: email.project,
      includeUnsubscribe: emailClass === 'marketing',
      sourceEmailId: emailId,
      footers,
    });

    // Use fromName from database if available, otherwise fall back to project name
    // The 'from' field in the database is just the email address
    const fromName = email.fromName || email.project.name;
    const fromEmail = email.from;

    // Remove internal headers before sending
    const publicHeaders = customHeaders ? {...customHeaders} : undefined;
    if (publicHeaders && RECIPIENT_OVERRIDE_HEADER in publicHeaders) {
      delete publicHeaders[RECIPIENT_OVERRIDE_HEADER];
    }

    // Build the outbound headers: standards-based defaults for the email class
    // plus any caller-supplied headers (which override the defaults).
    const outboundHeaders = buildEmailHeaders({
      emailClass,
      isCampaign: email.campaignId != null,
      hasListManagementLink: bodyHasListManagementLink(compiledHtml, email.contact.id),
      unsubscribeId: email.contact.id,
      sourceEmailId: emailId,
      customHeaders: publicHeaders,
    });

    // Build recipient with name if available
    const recipient: {name?: string; email: string} | string = email.toName
      ? {name: email.toName, email: recipientEmail}
      : recipientEmail;

    // Determine tracking based on project settings and email type
    const shouldTrack = EmailService.shouldTrackEmail(email.project.tracking, email.sourceType);

    // Check for phishing/dangerous content before sending
    const phishingCheck = await SecurityService.checkPhishingContent(
      email.projectId,
      email.project.name,
      email.from,
      formattedEmail.subject,
      compiledHtml,
    );

    if (phishingCheck.shouldDisable) {
      // Disable project immediately
      await SecurityService.disableProjectForPhishing(
        email.projectId,
        formattedEmail.subject,
        phishingCheck.confidence,
        'Phishing content detected',
      );
      disabledForPolicy = true;

      // Mark email as failed
      await prisma.email.update({
        where: {id: emailId},
        data: {
          status: EmailStatus.FAILED,
          error: 'This email could not be sent. The project has been disabled. Please contact support.',
        },
      });

      throw new Error(`Project ${email.projectId} has been disabled due to a policy violation`);
    }

    // Send via AWS SES
    handedToSes = true;
    const result = await sendRawEmail({
      from: {
        name: fromName,
        email: fromEmail,
      },
      to: typeof recipient === 'string' ? [recipient] : [{name: recipient.name, email: recipient.email}],
      content: {
        subject: formattedEmail.subject,
        html: compiledHtml,
      },
      reply: email.replyTo || undefined,
      headers: outboundHeaders,
      tracking: shouldTrack,
      attachments: email.attachments as {filename: string; content: string; contentType: string}[] | null,
      tags: {emailId, projectId: email.projectId, kind: 'email'},
    });
    accepted = {messageId: result.messageId, subject: formattedEmail.subject};

    // Kept on the job before anything else can fail, so a retry records this send rather
    // than repeating it
    await job.updateData({...job.data, accepted});

    await recordSent(email, accepted, recipientEmail);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (accepted) {
      // SES has the message. Try recording it once more here; if that fails too, the retry
      // records it from the job data.
      signale.error(`[EMAIL-PROCESSOR] Email ${emailId} was accepted by SES, but recording it failed:`, error);
      await recordSent(email, accepted, recipientEmail);
      return;
    }

    signale.error(`[EMAIL-PROCESSOR] Failed to send email ${emailId}:`, error);

    if (disabledForPolicy) {
      // Already marked failed, and the project is disabled: a retry could only fail again
      await finalizeCampaignSafely(email.campaignId);
      throw new UnrecoverableError(message);
    }

    if (handedToSes && !safeToRetrySend(error)) {
      // SES neither refused the email nor was it never reached: the connection failed after the
      // request went out, or an answer came back unreadable, and SES may have accepted the email.
      // Sending it again could deliver it twice -- once per retry -- so it is marked failed, as
      // possibly sent, and not retried.
      await prisma.email.update({
        where: {id: emailId},
        data: {
          status: EmailStatus.FAILED,
          error: `No answer from SES could be read; the email ${POSSIBLY_SENT_NOTE}: ${message}`,
        },
      });
      await FailureAlertService.recordEmail(email, message);
      await finalizeCampaignSafely(email.campaignId);
      throw new UnrecoverableError(message);
    }

    if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
      // Nothing was sent, or SES answered and refused it: back to PENDING so BullMQ's retry,
      // after its backoff, sends it
      await prisma.email.updateMany({
        where: {id: emailId, status: EmailStatus.SENDING},
        data: {status: EmailStatus.PENDING},
      });
      throw error;
    }

    // Last attempt
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: message,
      },
    });

    await FailureAlertService.recordEmail(email, message);
    await finalizeCampaignSafely(email.campaignId);

    throw error;
  }
}

export async function createEmailWorker() {
  // Fetch the rate limit (from env, AWS, or default)
  const rateLimit = await getEmailRateLimit();
  const concurrency = deriveWorkerConcurrency(rateLimit);
  signale.info(
    `[EMAIL-PROCESSOR] Worker concurrency: ${concurrency} (rate limit: ${rateLimit}/s)`,
  );
  const worker = new Worker<SendEmailJobData>(emailQueue.name, processEmailJob, {
    connection: emailQueue.opts.connection,
    concurrency,
    limiter: {
      max: rateLimit, // Max emails per second (from env, AWS SES quota, or default)
      duration: 1000,
    },
  });

  worker.on('completed', job => {
    signale.info(`[EMAIL-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[EMAIL-PROCESSOR] Job ${job?.id} failed:`, err.message);

    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void failAbandonedEmail(job.data.emailId);
    }
  });

  worker.on('error', err => {
    signale.error('[EMAIL-PROCESSOR] Worker error:', err);
  });

  return worker;
}
