/**
 * Plunk Lite's checks worker: the reputation check after bounces and complaints, every 15 minutes
 * the check that SES events reach the webhook and the one of Redis's memory, and every 5 minutes
 * the sweep of workflow runs a restart interrupted
 */

import type {PlunkLiteChecksJobData, SecurityCheckJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {plunkLiteChecksQueue} from '../services/QueueService.js';
import {checkRedisMemory} from '../services/RedisMemoryCheck.js';
import {ReputationCheck} from '../services/ReputationCheck.js';
import {checkEventPipeline} from '../services/SesEventMatch.js';
import {WorkflowRecoveryService} from '../services/WorkflowRecoveryService.js';

export async function processPlunkLiteCheck(job: Job<PlunkLiteChecksJobData>): Promise<void> {
  switch (job.name) {
    case 'security-check':
      return ReputationCheck.run(job.data as SecurityCheckJobData);
    case 'sns-health':
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
