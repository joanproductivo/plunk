/**
 * Plunk Lite's checks worker: the reputation check after bounces and complaints, every 15 minutes
 * the check that SES events reach the webhook (and of the dead-letter queue SNS leaves the ones it
 * could not deliver in) and the one of Redis's memory, and every 5 minutes the sweep of workflow
 * runs nothing would move on any more
 */

import type {PlunkLiteChecksJobData, SecurityCheckJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {DlqDrainService} from '../services/DlqDrainService.js';
import {plunkLiteChecksQueue, QueueService} from '../services/QueueService.js';
import {checkRedisMemory} from '../services/RedisMemoryCheck.js';
import {ReputationCheck} from '../services/ReputationCheck.js';
import {checkEventPipeline} from '../services/SesEventMatch.js';
import {WorkflowRecoveryService} from '../services/WorkflowRecoveryService.js';

export async function processPlunkLiteCheck(job: Job<PlunkLiteChecksJobData>): Promise<void> {
  switch (job.name) {
    case 'security-check':
      return ReputationCheck.run(job.data as SecurityCheckJobData);
    case 'sns-health':
      // The queue first: one question to SQS, and what it holds is the events the other check
      // finds missing. Its failure is logged and leaves the other check to run.
      try {
        if (await DlqDrainService.check()) {
          await QueueService.queueDlqDrain();
        }
      } catch (error) {
        signale.error('[PLUNK-LITE-CHECKS] Could not queue the drain of the dead-letter queue:', error);
      }
      return checkEventPipeline();
    case 'redis-memory':
      return checkRedisMemory();
    case 'workflow-recovery':
      await WorkflowRecoveryService.sweep();
      return;
    default:
      throw new Error(`Unknown Plunk Lite check: ${job.name}`);
  }
}

/** What a job that ran out of attempts leaves undone, said where the project sees it */
export async function onPlunkLiteCheckFailed(job: Job<PlunkLiteChecksJobData>, error: Error): Promise<void> {
  if (job.attemptsMade < (job.opts.attempts ?? 1)) {
    return;
  }
  if (job.name === 'security-check') {
    await ReputationCheck.exhausted(job.data as SecurityCheckJobData, error);
  }
}

export function createPlunkLiteChecksWorker(): Worker<PlunkLiteChecksJobData> {
  const worker = new Worker<PlunkLiteChecksJobData>(plunkLiteChecksQueue.name, processPlunkLiteCheck, {
    connection: plunkLiteChecksQueue.opts.connection,
    // A project's checks never overlap (one is deduplicated per project); two projects may
    concurrency: 2,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[PLUNK-LITE-CHECKS] Job ${job?.id} (${job?.name}) failed:`, error);
    if (job) {
      void onPlunkLiteCheckFailed(job, error);
    }
  });

  worker.on('error', error => {
    signale.error('[PLUNK-LITE-CHECKS] Worker error:', error);
  });

  return worker;
}
