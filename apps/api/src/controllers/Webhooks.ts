import {Controller, Post} from '@overnightjs/core';
import type {Prisma} from '@plunk/db';
import {EmailSourceType, EmailStatus} from '@plunk/db';
import {isMailboxSimulatorAddress} from '@plunk/shared';
import type {Request, Response} from 'express';
import {simpleParser} from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import signale from 'signale';
import type Stripe from 'stripe';

import {ProjectDisabledPaymentEmail, sendPlatformEmail} from '@plunk/email';
import React from 'react';

import {
  DASHBOARD_URI,
  IGNORE_AUTOMATIC_OPENS,
  LANDING_URI,
  STRIPE_ENABLED,
  STRIPE_WEBHOOK_SECRET,
} from '../app/constants.js';
import {stripe} from '../app/stripe.js';
import {prisma} from '../database/prisma.js';
import {BillingLimitService} from '../services/BillingLimitService.js';
import {CampaignService} from '../services/CampaignService.js';
import {CardVerificationService} from '../services/CardVerificationService.js';
import {ContactService} from '../services/ContactService.js';
import {hasRecipientOverride, recipientAddress} from '../services/EmailHeaderService.js';
import {EventService} from '../services/EventService.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {MembershipService} from '../services/MembershipService.js';
import {MeterService} from '../services/MeterService.js';
import {NtfyService} from '../services/NtfyService.js';
import {OutstandingInvoiceService} from '../services/OutstandingInvoiceService.js';
import {QueueService} from '../services/QueueService.js';
import {SecurityService} from '../services/SecurityService.js';
import {
  affectedAddresses,
  matchEmail,
  noteSnsRejection,
  parseSnsMessage,
  readSesNotification,
  recordReject,
  reportUnreadable,
  sentAddress,
  suppressUnmatched,
} from '../services/SesEventMatch.js';
import {SnsMessages} from '../services/SnsMessages.js';
import {SnsSignature} from '../services/SnsSignature.js';
import {SuppressionService} from '../services/SuppressionService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * How much a status is allowed to outrank the one already on the row.
 *
 * SES publishes its events through SNS, which makes no ordering guarantee, so this handler
 * sees them in an arbitrary order. Without a precedence the last event to arrive wins, and
 * "opened, then reported as spam" -- the ordinary way a complaint happens -- lands as often
 * as not in the order that leaves the row reading OPENED with `complainedAt` set. Measured
 * on production data, that was one complaint in five.
 *
 * Complaints outrank bounces because a recipient who reported the mail is the more useful
 * fact about that email, and because the pair is close to impossible anyway: an address
 * that hard-bounced never received anything to report.
 *
 * Statuses not listed here (PENDING, SENDING, FAILED, RECEIVED) are outside this handler's
 * concern; it is only ever called with the five SES event outcomes.
 */
const STATUS_RANK: Partial<Record<EmailStatus, number>> = {
  [EmailStatus.SENT]: 1,
  [EmailStatus.DELIVERED]: 2,
  [EmailStatus.OPENED]: 3,
  [EmailStatus.CLICKED]: 4,
  [EmailStatus.BOUNCED]: 5,
  [EmailStatus.COMPLAINED]: 6,
};

/**
 * The status to write, or `undefined` to leave the column as it is.
 *
 * Undefined rather than the current value so the caller can hand the result straight to
 * Prisma, which reads `undefined` as "don't touch this column" and so never writes a
 * no-op update.
 */
export function nextStatus(current: EmailStatus, incoming?: EmailStatus): EmailStatus | undefined {
  if (!incoming) {
    return undefined;
  }

  // An unranked current status (PENDING, SENDING, FAILED) is always superseded by a real
  // SES outcome: those mean "we have heard nothing back yet", and now we have.
  const currentRank = STATUS_RANK[current] ?? 0;
  const incomingRank = STATUS_RANK[incoming] ?? 0;

  return incomingRank >= currentRank ? incoming : undefined;
}

/**
 * Whether SES judged an Open to be made by software rather than a person. Mail providers fetch
 * the tracking pixel on their own -- Gmail's servers do it on delivery, whether or not anyone
 * reads the email -- and SES marks those fetches `isBotEvent: "Likely"`. Measured, Gmail's own
 * fetch was "Likely" and every real open was "Unlikely", including one seconds after delivery
 * and Apple Mail's proxy. An Open without the mark counts, as every Open did before SES added it.
 */
export function isAutomaticOpen(open?: {isBotEvent?: unknown} | null, enabled = IGNORE_AUTOMATIC_OPENS): boolean {
  return enabled && open?.isBotEvent === 'Likely';
}

/**
 * Webhooks Controller
 * Handles incoming webhooks from external services (AWS SNS/SES)
 */
@Controller('webhooks')
export class Webhooks {
  /**
   * Receive SNS webhook notifications from AWS SES
   * Handles outbound email events: delivery, open, click, bounce, complaint
   * Handles inbound email notifications: received emails via SES receiving
   */
  @Post('sns')
  @CatchAsync
  public async receiveSNSWebhook(req: Request, res: Response) {
    // The SNS message this request claimed, settled once it is answered (see SnsMessages)
    let claimedMessage: string | undefined;
    try {
      // Verify SNS message signature before processing anything
      const signature = await SnsSignature.verify(req.body as Record<string, string>);
      if (signature === 'unavailable') {
        // AWS's signing certificate could not be fetched. Nothing says the message is forged,
        // so a 5xx has SNS deliver it again rather than losing it.
        signale.warn('[WEBHOOK] SNS signing certificate unavailable, asking SNS to retry');
        return res.status(503).json({success: false, message: 'Could not verify SNS signature'});
      }
      if (signature === 'invalid') {
        // Error level, not warn: this is indistinguishable from a working install right up
        // until someone notices that no engagement has been recorded for days. Every event
        // for every project drops here, and nothing else in the system counts the misses.
        signale.error('[WEBHOOK] SNS signature verification failed — request rejected. All SES events are being dropped.');
        await noteSnsRejection('signature');
        return res.status(403).json({success: false, message: 'Invalid SNS signature'});
      }

      // A valid signature only proves AWS sent it: the topic must also be in our own account,
      // or anyone could subscribe this endpoint to a topic of theirs and publish forged events.
      // Checked before the subscription branch, so a foreign topic is never confirmed either.
      const topicOrigin = await SecurityService.snsTopicOrigin(req.body.TopicArn);
      if (topicOrigin === 'unknown') {
        // 5xx makes SNS retry, so a genuine event is delivered again once the lookup works
        return res.status(503).json({success: false, message: 'Could not verify SNS topic'});
      }
      if (topicOrigin === 'foreign') {
        signale.warn(`[WEBHOOK] SNS message rejected — topic is not in this AWS account: ${String(req.body.TopicArn)}`);
        await noteSnsRejection('topic');
        return res.status(403).json({success: false, message: 'Untrusted SNS topic'});
      }

      // Handle SNS subscription confirmation FIRST (before parsing Message field)
      if (req.body.Type === 'SubscriptionConfirmation') {
        signale.info('SNS Subscription Confirmation received');

        // Validate SubscribeURL to prevent SSRF: must be HTTPS and from an official AWS SNS host.
        // Legitimate URLs look like:
        //   https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&...
        const subscribeURL: unknown = req.body.SubscribeURL;
        if (typeof subscribeURL !== 'string') {
          signale.warn('SNS SubscriptionConfirmation missing SubscribeURL');
          return res.status(400).json({success: false, message: 'Invalid SubscribeURL'});
        }

        let parsedURL: URL;
        try {
          parsedURL = new URL(subscribeURL);
        } catch {
          signale.warn('SNS SubscriptionConfirmation has unparseable SubscribeURL');
          return res.status(400).json({success: false, message: 'Invalid SubscribeURL'});
        }

        // Only allow HTTPS requests to official AWS SNS endpoints.
        // The hostname must be exactly sns.<region>.amazonaws.com or sns.<region>.amazonaws.eu
        const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.(com|eu)$/;
        if (parsedURL.protocol !== 'https:' || !SNS_HOST_RE.test(parsedURL.hostname)) {
          signale.warn(`SNS SubscriptionConfirmation rejected — disallowed SubscribeURL host: ${parsedURL.hostname}`);
          return res.status(400).json({success: false, message: 'Invalid SubscribeURL'});
        }

        // Automatically confirm the subscription
        try {
          const confirmResponse = await fetch(subscribeURL);
          if (confirmResponse.ok) {
            signale.success('SNS subscription confirmed successfully');
            return res.status(200).json({
              success: true,
              message: 'Subscription confirmed',
            });
          } else {
            signale.error('Failed to confirm SNS subscription:', confirmResponse.statusText);
            return res.status(200).json({
              success: false,
              message: 'Failed to confirm subscription',
            });
          }
        } catch (confirmError) {
          signale.error('Error confirming SNS subscription:', confirmError);
          return res.status(200).json({
            success: false,
            message: 'Error confirming subscription',
          });
        }
      }

      // Someone removed this endpoint's subscription from one of our topics: no SES event will
      // arrive from it again, and nothing else would show it. Signed and from our own account, so
      // it is not something an outsider can post.
      if (req.body.Type === 'UnsubscribeConfirmation') {
        const topic = String(req.body.TopicArn);
        signale.error(`[WEBHOOK] SNS subscription to ${topic} was removed`);
        await FailureAlertService.recordForAll({
          sourceKey: 'sns:subscription',
          label: 'SES events subscription removed',
          error: `This server was unsubscribed from ${topic}: the events it published (bounces, complaints, deliveries) no longer arrive. Subscribe the webhook to it again.`,
        });
        return res.status(200).json({success: true});
      }

      // Handle SNS notification messages - parse the Message field
      if (req.body.Type !== 'Notification') {
        signale.warn('[WEBHOOK] Unknown SNS message type:', req.body.Type);
        return res.status(200).json({success: false, message: 'Unknown message type'});
      }

      // Parse the nested SES event from the Message field
      const body = parseSnsMessage(req.body.Message);
      if (body === undefined) {
        await reportUnreadable('the message is not JSON');
        return res.status(200).json({success: false, message: 'Unreadable message'});
      }

      const notification = readSesNotification(body);
      if (notification.kind === 'other') {
        signale.warn(`[WEBHOOK] Ignoring an SES notification of type ${String(notification.type)}`);
        return res.status(200).json({success: true});
      }
      if (notification.kind === 'invalid') {
        await reportUnreadable(notification.reason);
        return res.status(200).json({success: false, message: 'Unreadable message'});
      }

      const snsMessageId: string | undefined =
        typeof req.body.MessageId === 'string' && req.body.MessageId ? req.body.MessageId : undefined;
      if (snsMessageId && SnsMessages.deduplicates(notification.eventType)) {
        const claim = await SnsMessages.claim(snsMessageId);
        if (claim === 'seen') {
          signale.info(`[WEBHOOK] SNS message ${snsMessageId} was already handled, ignoring the copy`);
          return res.status(200).json({success: true});
        }
        if (claim === 'busy') {
          // Another copy is being handled: if it fails, this one is delivered again
          return res.status(503).json({success: false, message: 'Already being handled'});
        }
        claimedMessage = snsMessageId;
      }

      // Check if this is an inbound email notification (SES Receiving)
      if (notification.eventType === 'Received') {
        signale.info('[WEBHOOK] Received inbound email notification from SES');

        try {
          // Extract recipient addresses from the inbound email
          const recipients = body.receipt?.recipients || [];

          if (recipients.length === 0) {
            signale.warn('[WEBHOOK] No recipients found in inbound email');
            return res.status(200).json({success: true, message: 'No recipients found'});
          }

          // For each recipient, identify the domain and create events
          for (const recipient of recipients) {
            const recipientEmail = recipient as string;
            const domain = recipientEmail.split('@')[1];

            if (!domain) {
              signale.warn('[WEBHOOK] Invalid recipient email format:', recipientEmail);
              continue;
            }

            // Find ALL projects that have this domain verified
            // A domain can be shared across multiple projects if users are members of both
            const domainRecords = await prisma.domain.findMany({
              where: {
                domain,
                verified: true, // Only process emails for verified domains
              },
              include: {
                project: true,
              },
            });

            if (domainRecords.length === 0) {
              signale.info(`[WEBHOOK] No verified domain found for: ${domain}`);
              continue;
            }

            signale.info(
              `[WEBHOOK] Found ${domainRecords.length} project(s) with verified domain ${domain}. Processing inbound email for all.`,
            );

            // Extract sender information (same for all projects)
            const senderEmail = body.mail?.source;
            const senderFromHeader = body.mail?.commonHeaders?.from?.[0] || senderEmail;

            // Parse email content if available
            let htmlBody: string | undefined;

            if (body.content && typeof body.content === 'string') {
              try {
                const isBase64 = body.receipt?.action?.encoding === 'BASE64';
                const emailBuffer = isBase64
                  ? Buffer.from(body.content, 'base64')
                  : Buffer.from(body.content);

                const parsed = await simpleParser(emailBuffer);
                const raw =
                  (parsed.html ? String(parsed.html) : undefined) ??
                  parsed.textAsHtml ??
                  parsed.text ??
                  undefined;

                if (raw) {
                  htmlBody = sanitizeHtml(raw, {
                    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
                    allowedAttributes: {
                      ...sanitizeHtml.defaults.allowedAttributes,
                      img: ['src', 'alt', 'width', 'height'],
                      '*': ['style'],
                    },
                    allowedSchemes: ['http', 'https', 'mailto'],
                  });
                }
              } catch (parseError) {
                signale.error('[WEBHOOK] Failed to parse email content:', parseError);
              }
            }

            // Process inbound email for each project that has this domain verified
            for (const domainRecord of domainRecords) {
              signale.info(`[WEBHOOK] Processing inbound email for project: ${domainRecord.project.name}`);

              // Check billing limits before processing inbound email
              const limitCheck = await BillingLimitService.checkLimit(domainRecord.projectId, EmailSourceType.INBOUND);

              if (!limitCheck.allowed) {
                signale.warn(
                  `[WEBHOOK] Inbound email blocked for project ${domainRecord.project.name}: ${limitCheck.message}`,
                );
                continue; // Skip this project but continue processing for other projects
              }

              // An email row needs a contact, and the sender is the only one there could be
              if (!senderEmail) {
                signale.warn(`[WEBHOOK] Inbound email to ${recipientEmail} has no sender, skipping it`);
                continue;
              }

              // Find or create a contact for the sender in this project
              const contact = await ContactService.upsert(
                domainRecord.projectId,
                senderEmail,
                undefined, // No additional data
                true, // Subscribe by default for inbound email senders
              );

              // Create an Email record for tracking with parsed content
              const inboundEmail = await prisma.email.create({
                data: {
                  projectId: domainRecord.projectId,
                  contactId: contact.id,
                  subject: body.mail?.commonHeaders?.subject || '(No subject)',
                  body: htmlBody || '', // Store HTML body in the body field
                  from: recipientEmail, // The recipient address that received the email
                  sourceType: EmailSourceType.INBOUND,
                  status: EmailStatus.RECEIVED, // Inbound emails use RECEIVED status
                  deliveredAt: new Date(body.mail?.timestamp || new Date()),
                },
              });

              // Increment usage counter in cache
              await BillingLimitService.incrementUsage(domainRecord.projectId, EmailSourceType.INBOUND);

              // Record Stripe metering if project has customer
              if (domainRecord.project.customer) {
                await MeterService.recordEmailSent(
                  domainRecord.project.customer,
                  1, // Inbound emails count as 1 credit
                  `email_${inboundEmail.id}`,
                );
              }

              // Prepare event data with all inbound email details including body content
              const eventData = {
                messageId: body.mail?.messageId,
                from: senderEmail,
                fromHeader: senderFromHeader,
                to: recipientEmail,
                subject: body.mail?.commonHeaders?.subject,
                timestamp: body.mail?.timestamp,
                recipients: body.receipt?.recipients,
                hasContent: !!body.content,
                // Email body content
                body: htmlBody,
                // Security verdicts
                spamVerdict: body.receipt?.spamVerdict?.status,
                virusVerdict: body.receipt?.virusVerdict?.status,
                spfVerdict: body.receipt?.spfVerdict?.status,
                dkimVerdict: body.receipt?.dkimVerdict?.status,
                dmarcVerdict: body.receipt?.dmarcVerdict?.status,
                // Processing metadata
                processingTimeMillis: body.receipt?.processingTimeMillis,
              };

              // Create the email.received event (this will trigger workflows)
              await EventService.trackEvent(
                domainRecord.projectId,
                'email.received',
                contact.id,
                inboundEmail.id, // Link the event to the inbound email record
                eventData,
              );

              signale.success(
                `[WEBHOOK] Created email.received event for ${senderEmail} → ${recipientEmail} (project: ${domainRecord.project.name})`,
              );
            }
          }

          return res.status(200).json({success: true, message: 'Inbound email processed'});
        } catch (inboundError) {
          signale.error('[WEBHOOK] Error processing inbound email:', inboundError);
          // Return 200 to acknowledge receipt even if processing failed
          return res.status(200).json({success: true, message: 'Error processing inbound email'});
        }
      }

      // Handle outbound email event notifications (existing logic)
      const {eventType, mail} = notification;
      const match = await matchEmail(mail);
      if (match.kind === 'retry') {
        // An email sent moments ago may not have its send recorded yet: ask SNS to deliver the
        // event again
        signale.warn(`[WEBHOOK] ${eventType} event for unknown messageId ${mail.messageId}, asking SNS to retry`);
        return res.status(503).json({success: false, error: 'Email not found yet'});
      }
      if (match.kind === 'unmatched') {
        await suppressUnmatched(eventType, body, mail);
        return res.status(200).json({success: true});
      }
      const {email} = match;

      // The address the email went to, as SES was given it: the contact's at the time, or a
      // workflow's custom recipient. The contact may have changed address since.
      const contactAddress = email.contact.email.toLowerCase();
      const sentTo = sentAddress(mail, recipientAddress(email.headers, email.contact.email));

      // Mail addressed to the SES mailbox simulator is a rehearsal of bounce handling, not a
      // reputation event: it never leaves AWS, and AWS keeps it out of its own bounce rates,
      // complaint rates, sending quotas and reputation metrics. The event is processed
      // exactly like any other below -- status transition, activity feed, tracked event,
      // contact suppression -- but it raises no operator alert and runs no enforcement, so a
      // sender testing their integration cannot warn or disable their own project. The rates
      // themselves exclude these emails at the source; see SecurityService.calculateRates.
      const isSimulated = email.simulated || isMailboxSimulatorAddress(sentTo);

      const now = new Date();
      const updateData: Prisma.EmailUpdateInput = {};
      let eventName = `email.${eventType.toLowerCase()}`;

      // The first-seen timestamp this event records, if it records one, and whether it counts
      // toward the rate enforcement checks. Claimed below only if the row does not hold it yet:
      // SNS is at-least-once, so the same bounce or complaint arrives again -- sometimes several
      // copies at once -- and only the copy that claims it is the new suppression. Everything
      // that is not idempotent -- the operator alert, the tracked event and the enforcement that
      // can disable a project -- runs for that copy alone.
      let suppression: {field: 'bouncedAt' | 'complainedAt'; enforces: boolean} | undefined;

      // Whether this event takes the recipient off the list
      let unsubscribes = false;

      // Base event data with email metadata
      const baseEventData = {
        subject: email.subject,
        from: email.from,
        fromName: email.fromName,
        messageId: email.messageId,
        emailId: email.id,
        templateId: email.templateId,
        campaignId: email.campaignId,
        sourceType: email.sourceType,
      };
      let eventData: Record<string, unknown> = baseEventData;

      // Process event based on type
      switch (eventType) {
        case 'Delivery':
          signale.success(`[WEBHOOK] Delivery confirmed for ${email.contact.email} from ${email.project.name}`);
          updateData.status = EmailStatus.DELIVERED;
          updateData.deliveredAt = now;
          eventData = {
            ...baseEventData,
            deliveredAt: now.toISOString(),
          };
          break;

        case 'Open':
          // Counting an automatic fetch as an open would stamp openedAt, move segments and resume
          // workflows waiting for a real one, so nothing is written for it
          if (isAutomaticOpen(body.open)) {
            signale.info(`[WEBHOOK] Automatic open ignored for ${email.contact.email} from ${email.project.name}`);
            return res.status(200).json({success: true});
          }
          // The mark is logged only when it is text, so an unexpected payload cannot make logging
          // throw and lose an open that would have counted
          signale.success(
            `[WEBHOOK] Open received for ${email.contact.email} from ${email.project.name} (isBotEvent: ${typeof body.open?.isBotEvent === 'string' ? body.open.isBotEvent : 'none'})`,
          );
          // Only set openedAt on first open
          if (!email.openedAt) {
            updateData.openedAt = now;
          }
          // Incremented in the database: opens of one email arrive together, and a read-then-write
          // count lost all but one of them
          updateData.opens = {increment: 1};
          updateData.status = EmailStatus.OPENED;
          eventData = {
            ...baseEventData,
            openedAt: email.openedAt?.toISOString() || now.toISOString(),
            opens: (email.opens || 0) + 1,
            isFirstOpen: !email.openedAt,
          };
          break;

        case 'Click': {
          signale.success(`[WEBHOOK] Click received for ${email.contact.email} from ${email.project.name}`);
          const clickedLink = body.click?.link;
          // Only set clickedAt on first click
          if (!email.clickedAt) {
            updateData.clickedAt = now;
          }
          updateData.clicks = {increment: 1};
          updateData.status = EmailStatus.CLICKED;
          eventData = {
            ...baseEventData,
            link: clickedLink,
            clickedAt: email.clickedAt?.toISOString() || now.toISOString(),
            clicks: (email.clicks || 0) + 1,
            isFirstClick: !email.clickedAt,
          };
          break;
        }

        case 'Bounce': {
          const bounceType = body.bounce?.bounceType;
          const bounceSubType = body.bounce?.bounceSubType;

          if (bounceType === 'Transient') {
            // Soft bounce (e.g., out-of-office, mailbox full) - don't count toward bounce rate
            signale.info(
              `[WEBHOOK] Transient bounce received for ${email.contact.email} from ${email.project.name} (not counted toward bounce rate)`,
            );
            // Don't update email status or unsubscribe contact
            // Just track the event for visibility, under its own name: a workflow or webhook
            // listening for `email.bounce` acts on an address that is gone, which this one is not
            eventName = 'email.softbounce';
            eventData = {
              ...baseEventData,
              bounceType,
              transientBounce: true,
            };
            break;
          }

          // A permanent bounce, or one SES could not classify, which is treated as permanent to
          // be safe. Both unsubscribe the recipient; clearing `snoozedUntil` is what stops the
          // snooze sweep from resubscribing a hard-bounced address later and mailing it again
          // (see SNOOZE_CLEARED_ON_WRITE in ContactService).
          signale.warn(
            `[WEBHOOK] ${bounceType === 'Permanent' ? 'Permanent' : `Unknown (${bounceType})`} bounce received for ${email.contact.email} from ${email.project.name}`,
          );
          updateData.status = EmailStatus.BOUNCED;
          unsubscribes = true;

          // An address already on the account's suppression list was never attempted: SES
          // answers for it with a bounce of this subtype, and leaves it out of its own bounce
          // rate. It is left out of ours too -- no `bouncedAt` -- or reimporting addresses that
          // bounced long ago would push the project over its threshold without a single real
          // bounce. An unknown type does record `bouncedAt`, and so counts toward the rate, but
          // a guess never triggers enforcement on its own.
          if (bounceSubType !== 'OnAccountSuppressionList') {
            suppression = {field: 'bouncedAt', enforces: bounceType === 'Permanent'};
          }

          eventData = {
            ...baseEventData,
            bounceType,
            bounceSubType,
            ...(suppression && {bouncedAt: (email.bouncedAt ?? now).toISOString()}),
          };
          break;
        }

        case 'Complaint':
          signale.warn(`[WEBHOOK] Complaint received for ${email.contact.email} from ${email.project.name}`);
          updateData.status = EmailStatus.COMPLAINED;
          // Unsubscribe on complaint. `snoozedUntil` is cleared so the snooze sweep can never
          // resubscribe someone who reported this mail as spam.
          unsubscribes = true;

          // As with bounces, a complaint SES reports for an address already on the account's
          // suppression list is left out of the rate
          if (body.complaint?.complaintSubType !== 'OnAccountSuppressionList') {
            suppression = {field: 'complainedAt', enforces: true};
          }

          eventData = {
            ...baseEventData,
            ...(suppression && {complainedAt: (email.complainedAt ?? now).toISOString()}),
          };
          break;

        case 'Reject':
          // Not a bounce: the content was refused, not the address, so nothing is suppressed
          await recordReject(email, body.reject?.reason);
          return res.status(200).json({success: true});

        default:
          signale.warn(`[WEBHOOK] Unknown event type: ${eventType}`);
          return res.status(200).json({success: true});
      }

      // The addresses a bounce or complaint is about. The contact is only unsubscribed -- and
      // the event only tracked against them -- when the email went to them: a workflow email sent
      // to a custom recipient bounces for that recipient, not the contact, and that address is
      // kept off future sends by the account's suppression list. An email that went to the
      // contact had them as its only recipient, so its bounce is theirs even when SES names
      // another address -- the DSN's Final-Recipient, for an alias or a forward. One sent to an
      // address the contact has since left is not theirs any more.
      const affected = unsubscribes ? affectedAddresses(eventType, body, sentTo) : [];
      const contactIsAffected = unsubscribes && (sentTo === contactAddress || affected.includes(contactAddress));
      // The address kept off later sends: the contact's when the event is theirs, or the one the
      // email went to when the contact has left it. Not a workflow's custom recipient, which is
      // rarely a contact and which the account's suppression list at SES already keeps off.
      const suppressedAddress = contactIsAffected
        ? email.contact.email
        : !hasRecipientOverride(email.headers) && sentTo !== contactAddress
          ? sentTo
          : undefined;

      // `status` is dropped from the update when it would walk backwards over a suppression. SES
      // publishes through SNS, which does not guarantee ordering, so the ordinary sequence
      // "opened, then reported as spam" reaches this handler the other way round often enough
      // to matter -- one complaint in five, measured. Applying the Open blindly left the row
      // reading `OPENED` with `complainedAt` set, and anything that selects complaints by status
      // then silently missed it. `undefined` leaves the column alone.
      // A row failed before its send was recorded (possibly sent, found by its tags) keeps FAILED:
      // whether it counts as sent is the send path's to say, so only the event's marks are written.
      const keepsStatus = email.status === EmailStatus.FAILED && !email.sentAt;
      const status = keepsStatus ? undefined : nextStatus(email.status, updateData.status as EmailStatus | undefined);

      // Whether this copy of the event is the one that records it. SNS is at-least-once, so the
      // same bounce or complaint arrives again -- sometimes several copies at once -- and only
      // the copy that claims it may alert, enforce or start workflows. Other events are new
      // every time.
      let isNew = true;

      if (unsubscribes) {
        // Everything that records a bounce or complaint, written together: if any of it fails,
        // none of it is written, SNS delivers the notification again, and the redelivery is new
        // again. Other events are a single update and do not hold a transaction open.
        await prisma.$transaction(
          async tx => {
            // Claimed by its first-seen timestamp, or -- for an address already on the
            // suppression list, which records none -- by moving the email to its status. A row
            // that keeps its status has nothing to claim that by, so each copy counts.
            const claimed = suppression
              ? await tx.email.updateMany({
                  where: {id: email.id, [suppression.field]: null},
                  data: {[suppression.field]: now},
                })
              : keepsStatus
                ? {count: 1}
                : await tx.email.updateMany({
                    // Never over a bounce or complaint already recorded, which this would downgrade
                    where: {id: email.id, status: {notIn: [EmailStatus.BOUNCED, EmailStatus.COMPLAINED]}},
                    data: {status: updateData.status as EmailStatus},
                  });
            isNew = claimed.count === 1;

            // Only the copy that records the event unsubscribes: an old bounce delivered again --
            // from the dead-letter queue, say -- must not unsubscribe a contact who has since
            // subscribed again
            if (isNew && contactIsAffected) {
              await tx.contact.update({
                where: {id: email.contactId},
                data: {subscribed: false, snoozedUntil: null},
              });
            }

            // And kept off every later send, whatever resubscribes the contact in passing. Not for
            // a bounce SES could not classify: the address may well be fine, and SES leaves it off
            // its own list too.
            if (
              isNew &&
              suppressedAddress &&
              !isSimulated &&
              (eventType === 'Complaint' || body.bounce?.bounceType === 'Permanent')
            ) {
              await SuppressionService.record(
                tx,
                email.projectId,
                [suppressedAddress],
                eventType === 'Complaint' ? 'COMPLAINT' : 'BOUNCE',
                email.id,
              );
            }

            await tx.email.update({where: {id: email.id}, data: {...updateData, status}});
          },
          // A burst of events can queue for a connection; the default two-second wait would
          // answer 500 and lean on SNS's retries
          {maxWait: 10_000, timeout: 10_000},
        );
      } else {
        await prisma.email.update({where: {id: email.id}, data: {...updateData, status}});
      }

      // A copy of a bounce or complaint that is already recorded: the suppression stands, and
      // nothing that follows may run a second time
      if (!isNew) {
        signale.info(`[WEBHOOK] ${eventType} for email ${email.id} already recorded, ignoring the copy`);
        return res.status(200).json({success: true});
      }

      // Check security limits only for a suppression the project has not been charged for
      // yet. Re-running enforcement on a copy could only re-disable a project over history it
      // has already been judged against -- which is what happened to projects that were
      // manually re-enabled. The check logs its own failures rather than throwing.
      if (suppression?.enforces && !isSimulated) {
        // Only one metric moved, so only that metric's thresholds may disable the project.
        // One notification is one event type, so it can never be both.
        await SecurityService.checkAndEnforceSecurityLimits(
          email.projectId,
          eventType === 'Complaint' ? 'complaint' : 'bounce',
        );
      }

      // Operator notification for a new suppression, naming the address it is about, sent
      // last: it is not part of recording the suppression, so a failure to send it must never
      // fail the event
      const address = sentTo === contactAddress ? email.contact.email : (affected[0] ?? email.contact.email);
      const notify =
        suppression && !isSimulated
          ? eventType === 'Complaint'
            ? () => NtfyService.notifyEmailComplaint(email.project.name, email.projectId, address)
            : () =>
                NtfyService.notifyEmailBounce(
                  email.project.name,
                  email.projectId,
                  address,
                  String(body.bounce?.bounceType),
                )
          : undefined;

      // The suppression is recorded. What follows is answered with 200 even when it fails: a
      // redelivery would add the open or click to the counters twice, and could queue the event
      // again once its job has been removed from the queue. Losing a workflow trigger is the
      // lesser failure.
      try {
        // The campaign counters the stats endpoint reads live on the campaign row, and this
        // event has just moved one of them. They are not incremented from here: this handler
        // runs once per recipient per event, so a write per event would serialize thousands of
        // updates on a single row -- the same reason `sentCount` is not incremented in the send
        // path either. Marking the campaign costs one Redis SADD, and the sweep recounts it.
        if (email.campaignId) {
          await CampaignService.markStatsDirty(email.campaignId);
        }

        // Track the event in the worker, which starts and resumes the workflows listening for
        // it: a campaign's notifications arrive by the thousand, and running every workflow
        // inside the request held a database connection per notification SNS sent at once.
        // Not for a bounce or complaint of an address that is not the contact's: their
        // workflows, segments and webhooks would read it as the contact's own.
        if (!unsubscribes || contactIsAffected) {
          await QueueService.queueEventTracking(
            {projectId: email.projectId, eventName, contactId: email.contactId, emailId: email.id, data: eventData},
            snsMessageId,
          );
        }
      } catch (error) {
        signale.error(`[WEBHOOK] ${eventType} recorded for email ${email.id}, but queueing the event failed:`, error);
      }

      if (notify) {
        try {
          await notify();
        } catch (error) {
          signale.error(`[WEBHOOK] Failed to send the ${eventType} notification for email ${email.id}:`, error);
        }
      }

      signale.success(`[WEBHOOK] Processed ${eventType} event for email ${email.id}`);
      return res.status(200).json({success: true});
    } catch (error) {
      signale.error('[WEBHOOK] Error processing SNS webhook:', error);
      // 500 makes SNS deliver the notification again. Everything that reaches here failed
      // before the suppression was fully recorded, and a redelivery is safe: the first-seen
      // timestamps and the enforcement are gated on what the row already holds.
      return res.status(500).json({success: false, message: 'Failed to process SNS notification'});
    } finally {
      // After the answer, whatever it was: its status says whether the message was handled
      if (claimedMessage) {
        await SnsMessages.settle(claimedMessage, res.statusCode < 300);
      }
    }
  }

  /**
   * Receive Stripe webhook notifications
   * Handles subscription and payment events: checkout.session.completed, invoice.paid, etc.
   */
  @Post('incoming/stripe')
  @CatchAsync
  public async receiveStripeWebhook(req: Request, res: Response) {
    // Return 404 if billing is disabled
    if (!STRIPE_ENABLED || !stripe) {
      signale.warn('[WEBHOOK] Stripe webhook received but billing is disabled');
      return res.status(404).json({success: false, error: 'Billing is disabled'});
    }

    try {
      const sig = req.headers['stripe-signature'];

      if (!sig) {
        signale.warn('[WEBHOOK] Missing Stripe signature header');
        return res.status(400).json({success: false, error: 'Missing signature'});
      }

      // Verify webhook signature using raw body
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        signale.error('[WEBHOOK] Stripe signature verification failed:', err);
        return res.status(400).json({success: false, error: 'Invalid signature'});
      }

      signale.info(`[WEBHOOK] Received Stripe event: ${event.type}`);

      // Handle different event types
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const customerId = session.customer as string;
          const subscriptionId = session.subscription as string;
          const projectId = session.client_reference_id; // Assuming project ID is passed as reference

          if (!projectId) {
            signale.warn('[WEBHOOK] No client_reference_id in checkout session');
            break;
          }

          // The card Checkout saved. Recorded before anything else so that the card-change
          // webhooks Checkout may also fire recognise it as already in hand, not a new card.
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const paymentMethodId =
            typeof subscription.default_payment_method === 'string'
              ? subscription.default_payment_method
              : (subscription.default_payment_method?.id ?? null);

          // Update project with customer and subscription IDs. PENDING until the off-session
          // charge returns a verdict; the project is usable in the meantime, which is a few
          // seconds of exposure against a signal that otherwise takes a month to arrive.
          const updatedProject = await prisma.project.update({
            where: {id: projectId},
            data: {
              customer: customerId,
              subscription: subscriptionId,
              cardVerification: 'PENDING',
              cardVerificationAt: new Date(),
              cardVerificationSession: session.id,
              cardVerificationPaymentMethod: paymentMethodId,
              cardVerificationAttempts: 0,
            },
          });

          await stripe.customers.update(customerId, {name: updatedProject.name});

          const promoField = session.custom_fields?.find((f) => f.key === 'promo_code');
          const promoCode = promoField?.text?.value?.trim().toUpperCase();
          if (promoCode && promoCode !== 'SWITCH') {
            signale.info(`[WEBHOOK] Unknown promo code "${promoCode}" entered for project ${projectId}`);
          }

          // Verify the card accepts a merchant-initiated charge before trusting it with a
          // month of usage. Queued rather than inline: confirming a PaymentIntent can outlast
          // Stripe's webhook timeout, and a timeout means a redelivery — and a second charge.
          // Credit for the verification charge is applied by the job, once the outcome is known.
          await QueueService.queueCardVerification({
            projectId,
            customerId,
            currency: session.currency ?? 'eur',
            attemptKey: session.id,
            ...(paymentMethodId && {paymentMethodId}),
            ...(promoCode && {promoCode}),
          });

          signale.success(`[WEBHOOK] Checkout completed for project ${projectId}, card verification queued`);

          // Send notification about subscription started
          await NtfyService.notifySubscriptionStarted(updatedProject.name, projectId, subscriptionId);
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object;
          const customerId = invoice.customer as string;

          // Find project by customer ID
          const project = await prisma.project.findUnique({
            where: {customer: customerId},
          });

          if (!project) {
            signale.warn(`[WEBHOOK] No project found for customer ${customerId}`);
            break;
          }

          // Verification invoices are bookkeeping for a charge the verification job already
          // handled; they neither settle debt nor deserve an alert.
          if (invoice.metadata?.plunk_purpose === 'card_verification') {
            break;
          }

          signale.success(`[WEBHOOK] Invoice paid for project ${project.name} (${project.id})`);

          // Re-enable the project only if it was previously disabled for a failed payment.
          // Projects disabled for other reasons (reputation, phishing, manual) must stay disabled.
          if (project.disabled && project.disabledReason === 'PAYMENT_FAILED') {
            // Only once nothing is owed. Any paid invoice used to count, including the 0.00
            // first invoice of a brand-new subscription — a way to walk away from the debt.
            const outstanding = await OutstandingInvoiceService.list(customerId);

            if (outstanding.length === 0) {
              await prisma.project.update({
                where: {id: project.id},
                data: {disabled: false, disabledReason: null},
              });
              signale.success(`[WEBHOOK] Project ${project.name} (${project.id}) re-enabled after payment`);
            } else {
              signale.info(
                `[WEBHOOK] Project ${project.name} (${project.id}) still has ${outstanding.length} outstanding invoice(s), staying paused`,
              );
            }
          }

          // Send notification about invoice payment
          await NtfyService.notifyInvoicePaid(project.name, project.id);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerId = invoice.customer as string;

          // Only disable projects that are already consuming (recurring billing).
          // If billing_reason is 'subscription_create', this is a first-time payment
          // attempt and the project has never had an active subscription — don't disable.
          if (invoice.billing_reason === 'subscription_create') {
            signale.info(
              `[WEBHOOK] Payment failed on initial subscription attempt for customer ${customerId}, skipping disable`,
            );
            break;
          }

          // Find project by customer ID
          const project = await prisma.project.findUnique({
            where: {customer: customerId},
          });

          if (!project) {
            signale.warn(`[WEBHOOK] No project found for customer ${customerId}`);
            break;
          }

          signale.warn(`[WEBHOOK] Payment failed for project ${project.name} (${project.id}), disabling project`);

          await prisma.project.update({
            where: {id: project.id},
            data: {disabled: true, disabledReason: 'PAYMENT_FAILED'},
          });

          await NtfyService.notifyProjectDisabledForPayment(project.name, project.id);

          // Send email notification to project members
          try {
            const members = await MembershipService.getMembers(project.id);
            const emails = members.map(m => m.email);
            if (emails.length > 0) {
              const template = React.createElement(ProjectDisabledPaymentEmail, {
                projectName: project.name,
                projectId: project.id,
                dashboardUrl: DASHBOARD_URI,
                landingUrl: LANDING_URI,
              });
              await Promise.all(
                emails.map(email => sendPlatformEmail(email, 'Project Disabled - Payment Failed', template)),
              );
            }
          } catch (emailError) {
            signale.error(`[WEBHOOK] Failed to send project disabled email:`, emailError);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const subscriptionId = subscription.id;

          // Find project by subscription ID
          const project = await prisma.project.findUnique({
            where: {subscription: subscriptionId},
          });

          if (!project) {
            signale.warn(`[WEBHOOK] No project found for subscription ${subscriptionId}`);
            break;
          }

          // Clear subscription from project
          await prisma.project.update({
            where: {id: project.id},
            data: {
              subscription: null,
            },
          });

          signale.warn(`[WEBHOOK] Subscription deleted for project ${project.name} (${project.id})`);

          // Send notification about subscription cancellation
          await NtfyService.notifySubscriptionCancelled(project.name, project.id, subscriptionId);
          break;
        }

        case 'customer.updated': {
          const customer = event.data.object;
          const previous = event.data.previous_attributes as Partial<Stripe.Customer> | undefined;
          const paymentMethod = customer.invoice_settings?.default_payment_method;
          const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id;

          // Only a newly chosen default card matters here; a cleared one leaves nothing to test.
          if (previous?.invoice_settings?.default_payment_method !== undefined && paymentMethodId) {
            await CardVerificationService.handlePaymentMethodChange(customer.id, paymentMethodId);
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const subscriptionId = subscription.id;
          const previous = event.data.previous_attributes as Partial<Stripe.Subscription> | undefined;
          const newPaymentMethod = subscription.default_payment_method;
          const newPaymentMethodId = typeof newPaymentMethod === 'string' ? newPaymentMethod : newPaymentMethod?.id;

          // The portal may set the card on the subscription rather than the customer. Same
          // handling either way; the handler ignores the change it makes itself.
          if (previous?.default_payment_method !== undefined && newPaymentMethodId) {
            await CardVerificationService.handlePaymentMethodChange(subscription.customer as string, newPaymentMethodId);
          }

          // Find project by subscription ID
          const project = await prisma.project.findUnique({
            where: {subscription: subscriptionId},
          });

          if (!project) {
            signale.warn(`[WEBHOOK] No project found for subscription ${subscriptionId}`);
            break;
          }

          signale.info(`[WEBHOOK] Subscription updated for project ${project.name} (${project.id})`);
          signale.info(
            `[WEBHOOK] Status: ${subscription.status}, Cancel at period end: ${subscription.cancel_at_period_end}`,
          );

          // Send notification about subscription update
          await NtfyService.notifySubscriptionUpdated(project.name, project.id);
          break;
        }

        case 'radar.early_fraud_warning.created': {
          const warning = event.data.object as Stripe.Radar.EarlyFraudWarning;
          const chargeId = typeof warning.charge === 'string' ? warning.charge : warning.charge?.id;

          if (!chargeId) {
            signale.warn('[WEBHOOK] radar.early_fraud_warning.created missing charge ID');
            break;
          }

          signale.warn(`[WEBHOOK] Early fraud warning received for charge ${chargeId} (${warning.fraud_type})`);

          // Retrieve the charge to get card fingerprint and customer email
          const charge = await stripe.charges.retrieve(chargeId, {
            expand: ['payment_method_details', 'billing_details'],
          });

          const cardFingerprint = charge.payment_method_details?.card?.fingerprint ?? null;
          const customerEmail = charge.billing_details?.email ?? null;

          // Refund the charge
          try {
            await stripe.refunds.create({charge: chargeId});
            signale.success(`[WEBHOOK] Refunded charge ${chargeId} due to early fraud warning`);
          } catch (refundError) {
            signale.error(`[WEBHOOK] Failed to refund charge ${chargeId}:`, refundError);
          }

          // Add card fingerprint and email to Stripe Radar blocklist value lists
          if (cardFingerprint) {
            try {
              const lists = await stripe.radar.valueLists.list({alias: 'blocked_card_fingerprints'});
              let listId: string;

              const existingList = lists.data[0];
              if (existingList) {
                listId = existingList.id;
              } else {
                const newList = await stripe.radar.valueLists.create({
                  alias: 'blocked_card_fingerprints',
                  name: 'Blocked Card Fingerprints',
                  item_type: 'card_fingerprint',
                });
                listId = newList.id;
              }

              await stripe.radar.valueListItems.create({value_list: listId, value: cardFingerprint});
              signale.success(`[WEBHOOK] Added card fingerprint ${cardFingerprint} to Radar blocklist`);
            } catch (blocklistError) {
              signale.error(`[WEBHOOK] Failed to add card fingerprint to Radar blocklist:`, blocklistError);
            }
          }

          if (customerEmail) {
            try {
              const emailLists = await stripe.radar.valueLists.list({alias: 'blocked_emails'});
              let emailListId: string;

              const existingEmailList = emailLists.data[0];
              if (existingEmailList) {
                emailListId = existingEmailList.id;
              } else {
                const newList = await stripe.radar.valueLists.create({
                  alias: 'blocked_emails',
                  name: 'Blocked Emails',
                  item_type: 'email',
                });
                emailListId = newList.id;
              }

              await stripe.radar.valueListItems.create({value_list: emailListId, value: customerEmail});
              signale.success(`[WEBHOOK] Added email ${customerEmail} to Radar blocklist`);
            } catch (blocklistError) {
              signale.error(`[WEBHOOK] Failed to add email to Radar blocklist:`, blocklistError);
            }
          }

          await NtfyService.notifyEarlyFraudWarning(chargeId, warning.fraud_type, cardFingerprint, customerEmail);
          break;
        }

        // Unhandled events
        default:
          signale.info(`[WEBHOOK] Unhandled Stripe event type: ${event.type}`);
          break;
      }

      return res.status(200).json({success: true, received: true});
    } catch (error) {
      signale.error('[WEBHOOK] Error processing Stripe webhook:', error);
      return res.status(400).json({success: false, error: 'Webhook processing failed'});
    }
  }
}
