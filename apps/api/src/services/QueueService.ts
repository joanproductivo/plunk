import crypto from 'crypto';

import {CampaignStatus, EmailSourceType, EmailStatus, WorkflowExecutionStatus} from '@plunk/db';
import {type Job, Queue} from 'bullmq';
import type {RedisOptions} from 'ioredis';
import signale from 'signale';
import type {
  ApiRequestCleanupJobData,
  BulkContactActionJobData,
  CampaignBatchJobData,
  CampaignStatsSweepJobData,
  CardVerificationJobData,
  CardVerificationSweepJobData,
  ContactImportJobData,
  ContactSubscriptionEventsJobData,
  DomainVerificationJobData,
  CampaignCancelCleanupJobData,
  EmailBodyCleanupJobData,
  EmailRecoverySweepJobData,
  EventTrackingJobData,
  IdempotencyKeyCleanupJobData,
  MembershipEventsJobData,
  MeterEventJobData,
  PlunkLiteChecksJobData,
  ScheduledCampaignJobData,
  SecurityCheckJobData,
  SegmentCountJobData,
  SegmentMembershipEventsJobData,
  SendEmailJobData,
  SnoozeSweepJobData,
  WorkflowStepJobData,
} from '@plunk/types';

import {REDIS_URL} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {errorMessage} from '../database/redis.js';
import {parseRedisUrl} from '../utils/redis.js';

/** How long a change that is already written waits for a queue before carrying on without it */
const QUEUE_WAIT_MS = 3000;

/**
 * Queue Configuration
 */

const redisConnection: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Parse Redis URL
  ...parseRedisUrl(REDIS_URL),
};

/**
 * Queue Instances
 */

export const emailQueue = new Queue<SendEmailJobData>('email', {
  connection: redisConnection,
  defaultJobOptions: {
    // Exponential from 2s: the retries span about four minutes, so an email outlasts a
    // database or SES hiccup instead of being marked failed (or, once SES has it, left
    // unrecorded) a few seconds in
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 1000, // Keep last 1000 completed jobs
    removeOnFail: 5000, // Keep last 5000 failed jobs
  },
});

export const campaignQueue = new Queue<CampaignBatchJobData>('campaign', {
  connection: redisConnection,
  defaultJobOptions: {
    // Exponential from 5s: about ten minutes of retries, so a database outage does not end
    // the batch chain and leave the campaign half sent. A batch is safe to run again.
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** The ID of the job that ends a delay, or a wait's timeout: one per step execution */
const workflowJobId = (type: 'delay-end' | 'timeout', stepExecutionId: string) => `workflow-${type}-${stepExecutionId}`;

// Plunk Lite: 8 attempts over about 4 minutes, like emails, so a delay's end or a wait's timeout
// that comes due while the database restarts is not lost. Both claim the run before moving it, so a
// retry never moves it twice.
export const workflowQueue = new Queue<WorkflowStepJobData>('workflow', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export const scheduledQueue = new Queue<ScheduledCampaignJobData>('scheduled', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const importQueue = new Queue<ContactImportJobData>('import', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2, // Limited retries for imports
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    // Plunk Lite: fewer and for less time -- each kept its whole CSV, up to about 7 MB, in Redis
    removeOnComplete: {age: 24 * 3600, count: 20},
    removeOnFail: {age: 7 * 24 * 3600, count: 50},
  },
});

export const segmentCountQueue = new Queue<SegmentCountJobData>('segment-count', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 10, // Keep last 10 completed jobs
    removeOnFail: 50, // Keep last 50 failed jobs
  },
});

export const domainVerificationQueue = new Queue<DomainVerificationJobData>('domain-verification', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 10, // Keep last 10 completed jobs
    removeOnFail: 50, // Keep last 50 failed jobs
  },
});

export const apiRequestCleanupQueue = new Queue<ApiRequestCleanupJobData>('api-request-cleanup', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 5, // Keep last 5 completed jobs
    removeOnFail: 20, // Keep last 20 failed jobs
  },
});

export const idempotencyKeyCleanupQueue = new Queue<IdempotencyKeyCleanupJobData>('idempotency-key-cleanup', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 5, // Keep last 5 completed jobs
    removeOnFail: 20, // Keep last 20 failed jobs
  },
});

export const emailBodyCleanupQueue = new Queue<EmailBodyCleanupJobData>('email-body-cleanup', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 5, // Keep last 5 completed jobs
    removeOnFail: 20, // Keep last 20 failed jobs
  },
});

export const campaignCancelCleanupQueue = new Queue<CampaignCancelCleanupJobData>('campaign-cancel-cleanup', {
  connection: redisConnection,
  defaultJobOptions: {
    // Retried generously: the job is idempotent (it deletes what is left and re-checks
    // before promoting the campaign), and a campaign stuck at CANCELLED with nothing
    // sent is precisely the state this feature exists to avoid.
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const bulkContactQueue = new Queue<BulkContactActionJobData>('bulk-contact-actions', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2, // Limited retries for bulk operations
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 50, // Keep last 50 completed bulk operations
    removeOnFail: 100, // Keep last 100 failed bulk operations
  },
});

export const meterQueue = new Queue<MeterEventJobData>('meter', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 5000,
    removeOnFail: 10000,
  },
});

// Retries here only cover soft failures (network, Stripe 5xx, issuer timeouts). A hard
// decline is a verdict, not a failure, so the processor resolves it without throwing.
export const cardVerificationQueue = new Queue<CardVerificationJobData>('card-verification', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 4,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

// Reconciles campaign counters against the email rows the events landed on. Retries are
// pointless here beyond a transient blip: whatever is still dirty is swept again on the next
// run, so a failed sweep costs a couple of minutes of staleness rather than data.
export const campaignStatsSweepQueue = new Queue<CampaignStatsSweepJobData>('campaign-stats-sweep', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 10000,
    },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

export const cardVerificationSweepQueue = new Queue<CardVerificationSweepJobData>('card-verification-sweep', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

/**
 * Recovers emails nothing will move on its own: PENDING with no job, or SENDING after the run
 * that claimed them stopped. Retries are safe: every change is conditional on the state the
 * sweep found.
 */
export const emailRecoverySweepQueue = new Queue<EmailRecoverySweepJobData>('email-recovery-sweep', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

/**
 * Resubscribes contacts whose snooze window has ended. Retries are cheap and safe: the sweep
 * only ever acts on contacts that are still due, so a repeat run after a failure does nothing
 * to the ones it already woke.
 */
export const snoozeSweepQueue = new Queue<SnoozeSweepJobData>('snooze-sweep', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 20,
    removeOnFail: 50,
  },
});

/**
 * Segment entry/exit events fired outside the request that changed the membership (static, or
 * Plunk Lite: a dynamic segment recomputed from the dashboard), and (Plunk Lite) the subscription
 * events of bulk subscription changes.
 * Retries are safe: the worker records how far it got and resumes from there.
 */
export const segmentMembershipEventsQueue = new Queue<MembershipEventsJobData>('segment-membership-events', {
  connection: redisConnection,
  defaultJobOptions: {
    // Plunk Lite: 10 attempts over about 40 minutes, so a job stopped by the database being out
    // (it fails then, and resumes from its progress) outlasts a restart or an outage
    attempts: 10,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/**
 * SES events tracked outside the webhook request that received them. One attempt: tracking an
 * event starts and resumes workflows, and a run repeated after it got part of the way could
 * send their emails twice. A failed job stays in the queue, where it can be seen.
 */
export const eventTrackingQueue = new Queue<EventTrackingJobData>('event-tracking', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    // Kept up to a day (or the last 20,000), so a copy of the same notification that SNS
    // delivers again -- within minutes, normally -- finds its job and is not tracked twice
    removeOnComplete: {age: 86_400, count: 20_000},
    removeOnFail: 5000,
  },
});

/**
 * Plunk Lite's own checks: the sending reputation after a bounce or complaint, once per project
 * for a burst of them, whether SES events reach the webhook, Redis memory, and the workflow runs a
 * restart left RUNNING. Each job says how it is retried.
 */
export const plunkLiteChecksQueue = new Queue<PlunkLiteChecksJobData>('plunk-lite-checks', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** How long a reputation check waits for the rest of a burst of bounces and complaints */
const SECURITY_CHECK_DELAY_MS = 10_000;

function emailPriorityFor(sourceType: EmailSourceType): number {
  switch (sourceType) {
    case EmailSourceType.TRANSACTIONAL:
      return 1;
    case EmailSourceType.WORKFLOW:
      return 5;
    case EmailSourceType.CAMPAIGN:
      return 10;
    default:
      return 5;
  }
}

/**
 * Queue Service - Centralized queue management
 */
export class QueueService {
  /**
   * Add email to queue for sending.
   *
   * Transactional emails jump the queue ahead of workflow and campaign sends
   * via BullMQ's priority (lower number = higher precedence). This prevents
   * latency-sensitive sends (login codes, password resets) from queuing behind
   * large campaign bursts on the shared `email` queue.
   */
  public static async queueEmail(
    emailId: string,
    sourceType: EmailSourceType,
    delay?: number,
  ): Promise<Job<SendEmailJobData>> {
    return emailQueue.add(
      'send-email',
      {emailId},
      {
        delay,
        jobId: `email-${emailId}`,
        priority: emailPriorityFor(sourceType),
      },
    );
  }

  /**
   * Add campaign batch to queue for processing
   */
  public static async queueCampaignBatch(data: CampaignBatchJobData): Promise<Job<CampaignBatchJobData>> {
    return campaignQueue.add('process-batch', data, {
      // The generation keeps a later send of the same campaign from colliding with the
      // batch jobs of an earlier one, which BullMQ still holds and would silently keep
      jobId: `campaign-${data.campaignId}-${data.generation}-batch-${data.batchNumber}`,
    });
  }

  /**
   * Queue the end of a DELAY step: when the delay runs out, the execution moves on to the step
   * connected after it then, or completes if there is none
   */
  public static async queueWorkflowDelayEnd(
    executionId: string,
    stepId: string,
    stepExecutionId: string,
    delayMs: number,
  ): Promise<Job<WorkflowStepJobData>> {
    return workflowQueue.add(
      'delay-end',
      {executionId, stepId, stepExecutionId, type: 'delay-end'},
      {
        delay: delayMs,
        jobId: workflowJobId('delay-end', stepExecutionId),
      },
    );
  }

  /**
   * Queue a timeout handler for WAIT_FOR_EVENT steps
   */
  public static async queueWorkflowTimeout(
    executionId: string,
    stepId: string,
    stepExecutionId: string,
    timeoutMs: number,
  ): Promise<Job<WorkflowStepJobData>> {
    return workflowQueue.add(
      'timeout',
      {executionId, stepId, stepExecutionId, type: 'timeout'},
      {
        delay: timeoutMs,
        jobId: workflowJobId('timeout', stepExecutionId),
      },
    );
  }

  /**
   * Plunk Lite: make sure the job that ends a delay or a wait's timeout is queued, to run now: for a
   * run the recovery sweep finds still waiting well after it was due. A job that is still to run is
   * left as it is; one that finished or failed is replaced. Safe to repeat: the job claims the run
   * before moving it. Returns whether a job was queued.
   */
  public static async ensureWorkflowWaitEnd(
    type: 'delay-end' | 'timeout',
    executionId: string,
    stepId: string,
    stepExecutionId: string,
  ): Promise<boolean> {
    const jobId = workflowJobId(type, stepExecutionId);
    if (await this.clearFinishedJob(workflowQueue, jobId)) {
      return false;
    }
    await workflowQueue.add(type, {executionId, stepId, stepExecutionId, type}, {jobId});
    return true;
  }

  /**
   * Cancel a queued timeout job
   */
  public static async cancelWorkflowTimeout(stepExecutionId: string): Promise<void> {
    const jobId = workflowJobId('timeout', stepExecutionId);
    const job = await workflowQueue.getJob(jobId);

    if (job) {
      await job.remove();
      signale.info(`[QUEUE] Cancelled timeout job ${jobId}`);
    }
  }

  /**
   * Schedule campaign for future sending
   */
  public static async scheduleCampaign(campaignId: string, scheduledFor: Date): Promise<Job<ScheduledCampaignJobData>> {
    const delay = scheduledFor.getTime() - Date.now();
    const jobId = `scheduled-campaign-${campaignId}`;

    // Any job already under this id -- the campaign's earlier schedule, still waiting, or one that
    // finished or could not start -- would make BullMQ ignore the new one: the campaign would go
    // out at the old time, or never. Only a job already running is left alone.
    const previous = await scheduledQueue.getJob(jobId);
    let replaced = !previous;
    if (previous && (await previous.getState()) !== 'active') {
      // It can start between the check and the removal, which then fails as locked
      replaced = await previous.remove().then(
        () => true,
        () => false,
      );
    }

    return scheduledQueue.add(
      'send-scheduled-campaign',
      {campaignId},
      {
        delay: Math.max(0, delay),
        // A job of the earlier schedule still running keeps the id; this one gets its own, and the
        // running one skips the campaign once it reads the new time
        jobId: replaced ? jobId : `${jobId}-${scheduledFor.getTime()}`,
      },
    );
  }

  /**
   * Cancel scheduled campaign
   */
  public static async cancelScheduledCampaign(campaignId: string): Promise<void> {
    const jobId = `scheduled-campaign-${campaignId}`;
    const job = await scheduledQueue.getJob(jobId);

    if (job) {
      await job.remove();
    }
  }

  /**
   * Queue the cleanup that returns a cancelled campaign to draft.
   *
   * The job id is derived from the campaign so that re-running `cancel` while its
   * cleanup is still pending or running re-uses that job instead of starting a second
   * one racing it over the same rows.
   *
   * A finished job keeps the id for as long as BullMQ retains it, and an add under it
   * is dropped: the cleanup of a campaign cancelled again after it was sent again, or
   * of one whose cleanup ran out of attempts (the repair path), would never run, and
   * the campaign would stay CANCELLED for good. So a completed or failed job goes
   * first. A job that finishes between the check and the add still drops it; cancel
   * again once it has.
   */
  public static async queueCampaignCancelCleanup(
    campaignId: string,
    projectId: string,
    cancelledAt: Date,
  ): Promise<void> {
    const jobId = `campaign-cancel-cleanup-${campaignId}`;
    await this.clearFinishedJob(campaignCancelCleanupQueue, jobId);

    await campaignCancelCleanupQueue.add(
      'cleanup',
      {campaignId, projectId, cancelledAt: cancelledAt.toISOString()},
      {jobId},
    );
  }

  /**
   * Queue contact import job
   */
  public static async queueImport(
    projectId: string,
    csvData: string,
    filename: string,
  ): Promise<Job<ContactImportJobData>> {
    return importQueue.add(
      'import-contacts',
      {projectId, csvData, filename},
      {
        jobId: `import-${projectId}-${Date.now()}`,
      },
    );
  }

  /**
   * Get import job status and progress
   * @param jobId - The job ID
   * @param projectId - The project ID to verify authorization
   * @returns Job status or null if not found or unauthorized
   */
  public static async getImportJobStatus(jobId: string, projectId: string) {
    const job = await importQueue.getJob(jobId);

    if (!job) {
      return null;
    }

    // Security: Verify that the job belongs to the requesting project
    if (job.data.projectId !== projectId) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress;
    const returnValue = job.returnvalue;
    const failedReason = job.failedReason;

    return {
      id: job.id,
      state,
      progress,
      result: returnValue,
      // Plunk Lite: not the job's data, which holds the whole CSV, sent on every poll of the dashboard
      filename: job.data.filename,
      failedReason,
    };
  }

  /**
   * Queue a Stripe meter event for reliable delivery with retries
   */
  public static async queueMeterEvent(
    customerId: string,
    value: number,
    idempotencyKey?: string,
  ): Promise<Job<MeterEventJobData>> {
    return meterQueue.add(
      'record-meter-event',
      {customerId, value, idempotencyKey},
      {
        jobId: idempotencyKey ? `meter-${idempotencyKey}` : undefined,
      },
    );
  }

  /**
   * Queue an off-session card verification charge, at activation or after a card change.
   *
   * jobId is derived from the attempt key so a redelivered webhook cannot enqueue a second
   * charge, backing up the Stripe-side idempotency key in the processor.
   */
  public static async queueCardVerification(
    data: CardVerificationJobData,
    jobId?: string,
  ): Promise<Job<CardVerificationJobData>> {
    return cardVerificationQueue.add('verify-card', data, {
      jobId: jobId ?? `card-verification-${data.attemptKey}`,
    });
  }

  /**
   * Queue bulk contact action job
   */
  public static async queueBulkContactAction(data: BulkContactActionJobData): Promise<Job<BulkContactActionJobData>> {
    return bulkContactQueue.add('bulk-contact-action', data, {
      jobId: `bulk-${data.operation}-${data.projectId}-${Date.now()}`,
    });
  }

  /**
   * Get bulk action job status and progress
   * @param jobId - The job ID
   * @param projectId - The project ID to verify authorization
   * @returns Job status or null if not found or unauthorized
   */
  public static async getBulkActionJobStatus(jobId: string, projectId: string) {
    const job = await bulkContactQueue.getJob(jobId);

    if (!job) {
      return null;
    }

    // Security: Verify that the job belongs to the requesting project
    if (job.data.projectId !== projectId) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress;
    const returnValue = job.returnvalue;
    const failedReason = job.failedReason;

    return {
      id: job.id,
      state,
      progress,
      result: returnValue,
      data: job.data,
      failedReason,
    };
  }

  /**
   * Queue segment count update job
   */
  public static async queueSegmentCountUpdate(projectId?: string): Promise<Job<SegmentCountJobData>> {
    return segmentCountQueue.add(
      'update-segment-counts',
      {projectId},
      {
        jobId: projectId ? `segment-count-${projectId}-${Date.now()}` : `segment-count-all-${Date.now()}`,
      },
    );
  }

  /**
   * Queue the entry/exit events of a segment membership change. The job ID is set here so
   * a command the Redis client resends after a dropped connection cannot add the job twice.
   */
  public static async queueSegmentMembershipEvents(
    data: SegmentMembershipEventsJobData,
  ): Promise<Job<MembershipEventsJobData>> {
    return segmentMembershipEventsQueue.add(
      'track-segment-membership-events',
      {...data, type: 'segment-membership'},
      {
        jobId: `segment-events-${crypto.randomUUID()}`,
      },
    );
  }

  /**
   * Plunk Lite: queue the contact.subscribed / contact.unsubscribed events of a bulk subscription
   * change, in the same ordered queue, so they run with progress and retries instead of in a loop
   * nobody waits for
   */
  public static async queueContactSubscriptionEvents(
    data: Omit<ContactSubscriptionEventsJobData, 'type'>,
  ): Promise<Job<MembershipEventsJobData>> {
    return segmentMembershipEventsQueue.add(
      'track-contact-subscription-events',
      {type: 'contact-subscription', ...data},
      {jobId: `contact-events-${crypto.randomUUID()}`},
    );
  }

  /**
   * Remove the job with this ID if it has finished (or sits in no list), so adding one with the same
   * ID queues it again: BullMQ ignores an add whose ID is still taken. Returns true if a job that is
   * still to run, or running, holds the ID. A concurrent caller can have replaced it with a job that
   * is now running, and removing that one fails as locked: the running job does the work.
   */
  private static async clearFinishedJob(queue: Queue, jobId: string): Promise<boolean> {
    const previous = await queue.getJob(jobId);
    if (!previous) {
      return false;
    }
    const state = await previous.getState();
    if (state === 'completed' || state === 'failed' || state === 'unknown') {
      await previous.remove().catch(() => undefined);
      return false;
    }
    return true;
  }

  /**
   * Queue the job of a change that is already written, without letting the queue fail the caller
   * or hold it up: a retried request would write the change again. With Redis down `add` waits
   * instead of failing; it still completes once Redis is back, but the caller carries on after
   * QUEUE_WAIT_MS. A job the queue refuses is logged and lost.
   */
  public static async queueWithoutWaiting(add: Promise<unknown>, what: string): Promise<void> {
    const settled = add.then(
      () => true,
      error => {
        // Only the message: ioredis attaches the command and its arguments (contact IDs) to errors
        signale.error(`[QUEUE] Failed to queue ${what}: ${errorMessage(error)}`);
        return true;
      },
    );

    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      settled,
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), QUEUE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);

    if (!done) {
      signale.warn(`[QUEUE] Queueing ${what} is taking long; not waiting for it`);
    }
  }

  /**
   * Queue an SES event to be tracked by the worker. The job ID is the SNS message's, so copies of
   * one notification, which SNS delivers at least once, track the event once.
   */
  public static async queueEventTracking(
    data: EventTrackingJobData,
    snsMessageId: string | undefined,
  ): Promise<Job<EventTrackingJobData>> {
    return eventTrackingQueue.add('track-event', data, {
      jobId: snsMessageId ? `sns-${snsMessageId}` : undefined,
    });
  }

  /**
   * Queue the reputation check of a project, unless one is already waiting: the bounces and
   * complaints of a burst are judged together, ten seconds after the first. One that arrives while
   * the check runs queues another after it, so none is judged on rates read before it. Retried
   * while the database cannot answer, since a check that cannot read the rates has not found the
   * project healthy.
   *
   * The deduplication key only goes when its job ends. If it outlives the job (removed by hand, or
   * evicted: Redis must keep `noeviction`), every check would be deduplicated into a job that never
   * runs, so a key whose job is gone or finished is removed and the check queued again, once. If a
   * check queued meanwhile does the same, two run, which judges the project twice and changes nothing.
   */
  public static async queueSecurityCheck(data: SecurityCheckJobData): Promise<Job> {
    const deduplicationId = `security-check-${data.projectId}`;
    const add = () =>
      plunkLiteChecksQueue.add('security-check', data, {
        // BullMQ ignores a ttl with keepLastIfActive; a job id would stop the one queued behind a run
        deduplication: {id: deduplicationId, keepLastIfActive: true},
        delay: SECURITY_CHECK_DELAY_MS,
        attempts: 5,
        backoff: {type: 'exponential', delay: 5000},
      });

    const job = await add();
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') {
      return job;
    }
    signale.warn(
      `[QUEUE] The reputation check of project ${data.projectId} was held by job ${job.id}, ${state}: queueing it again`,
    );
    await plunkLiteChecksQueue.removeDeduplicationKey(deduplicationId);
    return add();
  }

  /**
   * Get queue statistics
   */
  public static async getStats() {
    const [
      emailCounts,
      campaignCounts,
      workflowCounts,
      scheduledCounts,
      importCounts,
      segmentCountCounts,
      domainVerificationCounts,
      apiRequestCleanupCounts,
      idempotencyKeyCleanupCounts,
      bulkContactCounts,
      meterCounts,
      segmentMembershipEventsCounts,
      eventTrackingCounts,
    ] = await Promise.all([
      emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      campaignQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      workflowQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      scheduledQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      importQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      segmentCountQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      domainVerificationQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      apiRequestCleanupQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      idempotencyKeyCleanupQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      bulkContactQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      meterQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      segmentMembershipEventsQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      eventTrackingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ]);

    return {
      email: emailCounts,
      campaign: campaignCounts,
      workflow: workflowCounts,
      scheduled: scheduledCounts,
      import: importCounts,
      segmentCount: segmentCountCounts,
      domainVerification: domainVerificationCounts,
      apiRequestCleanup: apiRequestCleanupCounts,
      idempotencyKeyCleanup: idempotencyKeyCleanupCounts,
      bulkContact: bulkContactCounts,
      meter: meterCounts,
      segmentMembershipEvents: segmentMembershipEventsCounts,
      eventTracking: eventTrackingCounts,
    };
  }

  /**
   * Pause all queues (for maintenance)
   */
  public static async pauseAll(): Promise<void> {
    await Promise.all([
      emailQueue.pause(),
      campaignQueue.pause(),
      workflowQueue.pause(),
      scheduledQueue.pause(),
      importQueue.pause(),
      segmentCountQueue.pause(),
      domainVerificationQueue.pause(),
      apiRequestCleanupQueue.pause(),
      bulkContactQueue.pause(),
      meterQueue.pause(),
    ]);
  }

  /**
   * Resume all queues
   */
  public static async resumeAll(): Promise<void> {
    await Promise.all([
      emailQueue.resume(),
      campaignQueue.resume(),
      workflowQueue.resume(),
      scheduledQueue.resume(),
      importQueue.resume(),
      segmentCountQueue.resume(),
      domainVerificationQueue.resume(),
      apiRequestCleanupQueue.resume(),
      bulkContactQueue.resume(),
      meterQueue.resume(),
    ]);
  }

  /**
   * Clean old jobs (should be run periodically)
   */
  public static async cleanOldJobs(): Promise<void> {
    const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours

    await Promise.all([
      emailQueue.clean(gracePeriod, 1000, 'completed'),
      emailQueue.clean(gracePeriod * 7, 1000, 'failed'), // Keep failed jobs for 7 days
      campaignQueue.clean(gracePeriod, 100, 'completed'),
      campaignQueue.clean(gracePeriod * 7, 500, 'failed'),
      workflowQueue.clean(gracePeriod, 1000, 'completed'),
      workflowQueue.clean(gracePeriod * 7, 1000, 'failed'),
      scheduledQueue.clean(gracePeriod, 100, 'completed'),
      scheduledQueue.clean(gracePeriod * 7, 500, 'failed'),
      importQueue.clean(gracePeriod, 50, 'completed'),
      importQueue.clean(gracePeriod * 7, 100, 'failed'),
      segmentCountQueue.clean(gracePeriod, 10, 'completed'),
      segmentCountQueue.clean(gracePeriod * 7, 50, 'failed'),
      domainVerificationQueue.clean(gracePeriod, 10, 'completed'),
      domainVerificationQueue.clean(gracePeriod * 7, 50, 'failed'),
      bulkContactQueue.clean(gracePeriod, 50, 'completed'),
      bulkContactQueue.clean(gracePeriod * 7, 100, 'failed'),
      meterQueue.clean(gracePeriod * 30, 5000, 'completed'), // Keep 30 days for billing audit
      meterQueue.clean(gracePeriod * 30, 10000, 'failed'),
    ]);
  }

  /**
   * Cancel all pending jobs for a specific project
   * This should be called when a project is disabled
   *
   * Plunk Lite: `onScheduledCancelled` gets the scheduled campaigns it cancels, as soon as they are,
   * for a reactivation to return them to the drafts. It must not throw.
   */
  public static async cancelAllProjectJobs(
    projectId: string,
    onScheduledCancelled?: (campaignIds: string[]) => Promise<void>,
  ): Promise<void> {
    signale.info(`[QUEUE] Cancelling all pending jobs for project ${projectId}`);

    // Cancel all scheduled campaigns for this project. A disable is final for what was planned:
    // re-enabling the project must not send them, so the campaign itself is cancelled, not only its job
    // Only the ones this cancels, and no campaign cancelled before
    const scheduledCampaigns = await prisma.campaign.updateManyAndReturn({
      where: {projectId, status: CampaignStatus.SCHEDULED},
      data: {status: CampaignStatus.CANCELLED},
      select: {id: true},
    });

    if (scheduledCampaigns.length > 0) {
      await onScheduledCancelled?.(scheduledCampaigns.map(campaign => campaign.id));
      for (const campaign of scheduledCampaigns) {
        await this.cancelScheduledCampaign(campaign.id);
      }

      signale.info(`[QUEUE] Cancelled ${scheduledCampaigns.length} scheduled campaigns for project ${projectId}`);
    }

    // Cancel all pending emails for this project
    const pendingEmails = await emailQueue.getJobs(['waiting', 'delayed']);
    for (const job of pendingEmails) {
      const email = await prisma.email.findUnique({
        where: {id: job.data.emailId},
        select: {projectId: true},
      });

      if (email?.projectId === projectId) {
        await job.remove();
        signale.info(`[QUEUE] Removed email job ${job.id}`);
      }
    }

    // Cancel all pending campaign batches for this project
    const campaignBatches = await campaignQueue.getJobs(['waiting', 'delayed']);
    for (const job of campaignBatches) {
      const campaign = await prisma.campaign.findUnique({
        where: {id: job.data.campaignId},
        select: {projectId: true},
      });

      if (campaign?.projectId === projectId) {
        await job.remove();
        signale.info(`[QUEUE] Removed campaign batch job ${job.id}`);
      }
    }

    // Cancel every workflow execution still in progress. Removing their queued jobs alone left them
    // WAITING forever, and re-enabling the project must not resume them either. Jobs still queued for
    // them stay in Redis and do nothing when they fire, since the engine never moves a cancelled execution on.
    const cancelledExecutions = await prisma.workflowExecution.updateMany({
      where: {
        workflow: {projectId},
        status: {in: [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING]},
      },
      data: {
        status: WorkflowExecutionStatus.CANCELLED,
        completedAt: new Date(),
        exitReason: 'Project disabled',
      },
    });

    if (cancelledExecutions.count > 0) {
      signale.info(`[QUEUE] Cancelled ${cancelledExecutions.count} workflow executions for project ${projectId}`);
    }

    // Mark every still-PENDING email for this project as FAILED. We just stripped
    // their queue jobs, so without this they'd sit as PENDING forever and any
    // campaign waiting on them would stay stuck in SENDING.
    const failed = await prisma.email.updateMany({
      where: {projectId, status: EmailStatus.PENDING},
      data: {status: EmailStatus.FAILED, error: 'Project is disabled'},
    });

    if (failed.count > 0) {
      signale.info(`[QUEUE] Marked ${failed.count} pending emails as failed for project ${projectId}`);
    }

    // Finalize any in-flight campaigns. With the orphaned PENDING emails now FAILED
    // (terminal), the campaign can move to SENT with a partial sentCount instead of
    // staying stuck in SENDING. Reconcile totalRecipients first since the batch
    // chain may have been cut short.
    const sendingCampaigns = await prisma.campaign.findMany({
      where: {projectId, status: CampaignStatus.SENDING},
      select: {id: true},
    });

    if (sendingCampaigns.length > 0) {
      const {CampaignService} = await import('./CampaignService.js');
      for (const campaign of sendingCampaigns) {
        const actualEmailCount = await prisma.email.count({where: {campaignId: campaign.id}});
        await prisma.campaign.update({
          where: {id: campaign.id},
          data: {totalRecipients: actualEmailCount},
        });
        await CampaignService.finalizeIfDone(campaign.id);
      }
    }

    signale.info(`[QUEUE] Finished cancelling jobs for project ${projectId}`);
  }

  /**
   * Close all queue connections
   */
  public static async closeAll(): Promise<void> {
    await Promise.all([
      emailQueue.close(),
      campaignQueue.close(),
      workflowQueue.close(),
      scheduledQueue.close(),
      importQueue.close(),
      segmentCountQueue.close(),
      domainVerificationQueue.close(),
      apiRequestCleanupQueue.close(),
      bulkContactQueue.close(),
      meterQueue.close(),
      segmentMembershipEventsQueue.close(),
      eventTrackingQueue.close(),
      plunkLiteChecksQueue.close(),
    ]);
  }
}
