/**
 * Background Job: Email Recovery Sweep
 *
 * The send path moves every email from PENDING to SENDING to a terminal state, but two kinds of
 * row can fall out of it with nothing left to move them on, and each holds its campaign in
 * SENDING for good:
 *
 * - PENDING with no live job: the request that created the row died before queueing it, a
 *   project disable removed its job, or the job ran out of attempts without the failure being
 *   recorded (a stalled job fails without the worker's `failed` event).
 * - SENDING with no run: the worker was killed after claiming the email.
 *
 * Every five minutes this looks at the oldest of them and settles each by its job's state. It
 * never sends anything: an email without a job is marked failed, not queued again. A job that is
 * gone may have finished -- BullMQ keeps only the latest completed ones, and a database restored
 * from a backup has PENDING rows for emails long sent -- and a transactional email the API
 * answered 500 for was usually sent again by its caller. A campaign batch that dies requeues its
 * own unsent emails when BullMQ runs it again.
 */

import {EmailStatus} from '@plunk/db';
import type {EmailRecoverySweepJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {emailQueue, emailRecoverySweepQueue} from '../services/QueueService.js';

import {finalizeCampaignSafely} from './email-processor.js';

/** Younger than this, a PENDING or SENDING email is most likely just waiting its turn */
const STUCK_AFTER_MS = 15 * 60 * 1000;

/** Rows looked at per kind and run, oldest first */
const BATCH_SIZE = 500;

/** Rounds of retries the sweep gives an accepted email whose send could not be recorded */
const MAX_SWEEP_RETRIES = 3;

/** Job states in which the email's job will still run on its own */
const LIVE_JOB_STATES = new Set(['waiting', 'prioritized', 'delayed', 'active', 'waiting-children']);

const STUCK_EMAIL_SELECT = {
  id: true,
  projectId: true,
  campaignId: true,
  workflowExecutionId: true,
  contact: {select: {email: true}},
  campaign: {select: {name: true}},
  project: {select: {disabled: true}},
} as const;

export interface RecoverySweepResult {
  retried: number;
  failed: number;
}

async function jobOf(emailId: string) {
  const job = await emailQueue.getJob(`email-${emailId}`);
  return {job, state: job ? await job.getState() : 'missing'};
}

/**
 * Mark an email failed if it is still in the state the sweep found it in, then let its
 * campaign finish. Returns whether this run made the change.
 */
async function fail(
  email: {
    id: string;
    projectId: string;
    campaignId: string | null;
    workflowExecutionId: string | null;
    contact: {email: string};
    campaign: {name: string} | null;
  },
  from: EmailStatus,
  error: string,
  alert: boolean,
): Promise<boolean> {
  const changed = await prisma.email.updateMany({
    where: {id: email.id, status: from},
    data: {status: EmailStatus.FAILED, error},
  });

  if (changed.count === 0) {
    return false;
  }

  if (alert) {
    await FailureAlertService.recordEmail(email, error);
  }
  await finalizeCampaignSafely(email.campaignId);
  return true;
}

/** Why a PENDING email whose job is not live was never sent */
function pendingFailure(state: string, projectDisabled: boolean): string {
  if (state === 'failed') {
    return 'Could not be sent after every retry';
  }
  if (projectDisabled) {
    return 'Project is disabled';
  }
  return 'Never sent: its job is gone';
}

export async function sweepStuckEmails(now = new Date()): Promise<RecoverySweepResult> {
  const result: RecoverySweepResult = {retried: 0, failed: 0};
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);

  // PENDING past the point of waiting its turn, and no job that will send it
  const pending = await prisma.email.findMany({
    where: {status: EmailStatus.PENDING, createdAt: {lt: stuckBefore}},
    select: STUCK_EMAIL_SELECT,
    orderBy: {createdAt: 'asc'},
    take: BATCH_SIZE,
  });

  for (const email of pending) {
    try {
      const {state} = await jobOf(email.id);

      if (LIVE_JOB_STATES.has(state)) {
        continue;
      }

      // A lost job is worth an alert: it means a send path broke. A disabled project's emails
      // are expected to stop.
      if (
        await fail(email, EmailStatus.PENDING, pendingFailure(state, email.project.disabled), !email.project.disabled)
      ) {
        result.failed++;
      }
    } catch (error) {
      signale.error(`[EMAIL-RECOVERY-SWEEP] Could not settle pending email ${email.id}:`, error);
    }
  }

  // SENDING with no run behind it any more
  const sending = await prisma.email.findMany({
    where: {status: EmailStatus.SENDING, updatedAt: {lt: stuckBefore}},
    select: STUCK_EMAIL_SELECT,
    orderBy: {updatedAt: 'asc'},
    take: BATCH_SIZE,
  });

  for (const email of sending) {
    try {
      const {job, state} = await jobOf(email.id);

      // Still running, or queued to run again -- a retry that records an accepted send waits
      // its turn behind a large campaign
      if (LIVE_JOB_STATES.has(state)) {
        continue;
      }

      const sweepRetries = job?.data.sweepRetries ?? 0;

      if (job && state === 'failed' && job.data.accepted && sweepRetries < MAX_SWEEP_RETRIES) {
        // SES accepted it and recording the send failed on every attempt: a retry records it
        // from the job data, without sending it again. BullMQ keeps the attempts already made,
        // so they are reset for the retry to get its own round, and the rounds are counted.
        await job.updateData({...job.data, sweepRetries: sweepRetries + 1});
        await job.retry('failed', {resetAttemptsMade: true});
        result.retried++;
        continue;
      }

      const error =
        job?.data.accepted && state === 'failed'
          ? 'Sent, but the send could not be recorded after every retry'
          : 'Stopped while sending; may have been sent';

      if (await fail(email, EmailStatus.SENDING, error, true)) {
        result.failed++;
      }
    } catch (error) {
      signale.error(`[EMAIL-RECOVERY-SWEEP] Could not settle sending email ${email.id}:`, error);
    }
  }

  return result;
}

async function processSweep(_job: Job<EmailRecoverySweepJobData>): Promise<RecoverySweepResult> {
  const result = await sweepStuckEmails();

  if (result.retried + result.failed > 0) {
    signale.info(`[EMAIL-RECOVERY-SWEEP] Retried ${result.retried}, failed ${result.failed} stuck email(s)`);
  }

  return result;
}

export function createEmailRecoverySweepWorker(): Worker<EmailRecoverySweepJobData> {
  const worker = new Worker<EmailRecoverySweepJobData>(emailRecoverySweepQueue.name, processSweep, {
    connection: emailRecoverySweepQueue.opts.connection,
    // One sweep at a time: two runs would look at the same rows
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[EMAIL-RECOVERY-SWEEP] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[EMAIL-RECOVERY-SWEEP] Worker error:', error);
  });

  return worker;
}
