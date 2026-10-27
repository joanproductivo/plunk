import type {EmailBodyCleanupJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {Worker} from 'bullmq';
import type {RedisOptions} from 'ioredis';
import signale from 'signale';

import {REDIS_URL} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {parseRedisUrl} from '../utils/redis.js';

/**
 * Email Body Cleanup Worker
 * Blanks the rendered HTML body and drops the attachments of emails past the retention
 * window. The row is kept so delivery history, event counts and analytics stay intact;
 * only the body and the attachments — by far the largest columns, and never sent again
 * this late — are dropped. Runs daily.
 */

const RETENTION_DAYS = 90;
const BATCH_SIZE = 1000; // Update in batches to avoid long-held row locks

/**
 * Process email body cleanup job. Exported so tests can run it without a queue.
 */
export async function processCleanup(job: Job<EmailBodyCleanupJobData>): Promise<{cleared: number}> {
  signale.info('[EMAIL-BODY-CLEANUP] Starting cleanup of email bodies past retention...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  let totalCleared = 0;

  try {
    for (;;) {
      // updateMany has no LIMIT, so bound each statement with a subselect. The
      // `body <> ''` predicate keeps already-cleared rows out of every later batch
      // and is served by the partial index emails_createdAt_unpurged_idx. Attachments
      // go with the body, so a row cleared before they did keeps its attachments.
      const cleared = await prisma.$executeRaw`
        UPDATE "emails"
        SET "body" = '', "attachments" = NULL
        WHERE "id" IN (
          SELECT "id" FROM "emails"
          WHERE "createdAt" < ${cutoffDate}
            AND "body" <> ''
          ORDER BY "createdAt"
          LIMIT ${BATCH_SIZE}
        )
      `;

      totalCleared += cleared;

      if (cleared < BATCH_SIZE) {
        break;
      }

      signale.info(`[EMAIL-BODY-CLEANUP] Cleared ${totalCleared} bodies so far, continuing...`);
      // Small delay between batches to reduce database load
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    signale.success(
      `[EMAIL-BODY-CLEANUP] Cleanup complete. Cleared ${totalCleared} bodies older than ${RETENTION_DAYS} days (before ${cutoffDate.toISOString()})`,
    );

    await job.updateProgress(100);

    return {cleared: totalCleared};
  } catch (error) {
    signale.error('[EMAIL-BODY-CLEANUP] Error during cleanup:', error);
    throw error;
  }
}

/**
 * Create the email body cleanup worker
 */
export function createEmailBodyCleanupWorker(): Worker<EmailBodyCleanupJobData> {
  const redisConnection: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...parseRedisUrl(REDIS_URL),
  };

  const worker = new Worker<EmailBodyCleanupJobData>('email-body-cleanup', processCleanup, {
    connection: redisConnection,
    concurrency: 1, // Only run one cleanup job at a time
  });

  worker.on('completed', job => {
    signale.success(`[EMAIL-BODY-CLEANUP] Job ${job.id} completed:`, job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[EMAIL-BODY-CLEANUP] Job ${job?.id} failed:`, err);
  });

  worker.on('error', err => {
    signale.error('[EMAIL-BODY-CLEANUP] Worker error:', err);
  });

  return worker;
}
