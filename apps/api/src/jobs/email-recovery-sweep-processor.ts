/**
 * Background Job: Email Recovery Sweep
 *
 * The send path moves every email from PENDING to SENDING to a terminal state, but two kinds of
 * row can fall out of it with nothing left to move them on, and each holds its campaign in
 * SENDING for good:
 *
 * - PENDING with no job: the request or batch that created the row died before queueing it, a
 *   project disable removed its job, or the job ran out of attempts without the failure being
 *   recorded (a stalled job fails without the worker's `failed` event).
 * - SENDING with no run: the worker was killed after claiming the email.
 *
 * Every five minutes this looks at the oldest of them and settles each one by its job's state.
 * It never sends anything twice: an email is only queued again when it has no job at all and was
 * never handed to SES, and an email that may have reached SES is marked failed, not resent.
 */

import type {EmailRecoverySweepJobData} from '@plunk/types';
import {EmailStatus} from '@plunk/db';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {emailQueue, emailRecoverySweepQueue, QueueService} from '../services/QueueService.js';

import {finalizeCampaignSafely} from './email-processor.js';

/** Younger than this, a PENDING or SENDING email is most likely just waiting its turn */
const STUCK_AFTER_MS = 15 * 60 * 1000;

/**
 * Older than this, a PENDING email is never queued again: its moment has passed (a password
 * reset from last week), and the body cleanup may already have emptied it
 */
const EXPIRED_AFTER_MS = 48 * 60 * 60 * 1000;

/** Rows looked at per kind and run, oldest first */
const BATCH_SIZE = 500;

/** Job states in which the email's job will still run on its own */
const LIVE_JOB_STATES = new Set(['waiting', 'prioritized', 'delayed', 'active', 'waiting-children']);

const STUCK_EMAIL_SELECT = {
  id: true,
  projectId: true,
  campaignId: true,
  workflowExecutionId: true,
  sourceType: true,
  contact: {select: {email: true}},
  campaign: {select: {name: true}},
  project: {select: {disabled: true}},
} as const;

export interface RecoverySweepResult {
  requeued: number;
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

export async function sweepStuckEmails(now = new Date(), batchSize = BATCH_SIZE): Promise<RecoverySweepResult> {
  const result: RecoverySweepResult = {requeued: 0, retried: 0, failed: 0};
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
  const expiredBefore = new Date(now.getTime() - EXPIRED_AFTER_MS);

  // PENDING for too long to still be worth sending
  const expired = await prisma.email.findMany({
    where: {status: EmailStatus.PENDING, createdAt: {lt: expiredBefore}},
    select: STUCK_EMAIL_SELECT,
    orderBy: {createdAt: 'asc'},
    take: batchSize,
  });

  for (const email of expired) {
    if (await fail(email, EmailStatus.PENDING, 'Expired, never sent', false)) {
      result.failed++;
    }
  }

  // PENDING past the point of waiting its turn: settled by what its job is doing
  const pending = await prisma.email.findMany({
    where: {status: EmailStatus.PENDING, createdAt: {lt: stuckBefore, gte: expiredBefore}},
    select: STUCK_EMAIL_SELECT,
    orderBy: {createdAt: 'asc'},
    take: batchSize,
  });

  for (const email of pending) {
    const {state} = await jobOf(email.id);

    if (LIVE_JOB_STATES.has(state)) {
      continue;
    }

    if (state === 'failed') {
      if (await fail(email, EmailStatus.PENDING, 'Could not be sent after every retry', true)) {
        result.failed++;
      }
    } else if (state === 'completed') {
      // A finished job whose row is still PENDING: the database was restored from before the
      // send. Sending it again could deliver it twice.
      if (await fail(email, EmailStatus.PENDING, 'Not sent: its job had already finished', true)) {
        result.failed++;
      }
    } else if (email.project.disabled) {
      if (await fail(email, EmailStatus.PENDING, 'Project is disabled', false)) {
        result.failed++;
      }
    } else {
      // No job at all, and never handed to SES: queue it. The job id is the email's, so a job
      // created in the meantime is not doubled.
      await QueueService.queueEmail(email.id, email.sourceType);
      result.requeued++;
    }
  }

  // SENDING with no run behind it any more
  const sending = await prisma.email.findMany({
    where: {status: EmailStatus.SENDING, updatedAt: {lt: stuckBefore}},
    select: STUCK_EMAIL_SELECT,
    orderBy: {updatedAt: 'asc'},
    take: batchSize,
  });

  for (const email of sending) {
    const {job, state} = await jobOf(email.id);

    if (state === 'active') {
      continue;
    }

    if (job && state === 'failed' && job.data.accepted) {
      // SES accepted it and recording the send failed on every attempt: a retry records it
      // from the job data, without sending it again
      await job.retry('failed');
      result.retried++;
      continue;
    }

    if (await fail(email, EmailStatus.SENDING, 'Stopped while sending; may have been sent', true)) {
      result.failed++;
    }
  }

  return result;
}

async function processSweep(_job: Job<EmailRecoverySweepJobData>): Promise<RecoverySweepResult> {
  const result = await sweepStuckEmails();

  if (result.requeued + result.retried + result.failed > 0) {
    signale.info(
      `[EMAIL-RECOVERY-SWEEP] Requeued ${result.requeued}, retried ${result.retried}, failed ${result.failed} stuck email(s)`,
    );
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
