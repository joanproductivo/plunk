/**
 * Plunk Lite's drain of the dead-letter queue of SES events: one at a time, handing each message to
 * the webhook, and queued again while the queue may hold more
 */

import type {DlqDrainJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {DlqDrainService} from '../services/DlqDrainService.js';
import {plunkLiteDlqQueue, QueueService} from '../services/QueueService.js';

export function createDlqWorker(): Worker<DlqDrainJobData> {
  // Set once the worker starts closing, so a drain stops between messages instead of being cut off
  let closing = false;

  const worker = new Worker<DlqDrainJobData>(
    plunkLiteDlqQueue.name,
    async (_job: Job<DlqDrainJobData>) => {
      const result = await DlqDrainService.drain(() => closing);
      if (result.more && !closing) {
        await QueueService.queueDlqDrain();
      } else if (!result.more) {
        // Empty now, or holding only what comes back later: closes the alarm's notice if empty
        await DlqDrainService.check();
      }
    },
    {connection: plunkLiteDlqQueue.opts.connection, concurrency: 1},
  );

  worker.on('closing', () => {
    closing = true;
  });

  worker.on('failed', (job, error) => {
    signale.error(`[DLQ] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[DLQ] Worker error:', error);
  });

  return worker;
}
