/**
 * Background Job: Campaign Processor
 * Processes campaign batches (queues emails for each contact in the batch)
 */

import {CampaignStatus} from '@plunk/db';
import type {CampaignBatchJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {CampaignService} from '../services/CampaignService.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {campaignQueue, QueueService} from '../services/QueueService.js';

/** Plunk Lite: rounds of attempts the email recovery sweep gives a campaign batch that failed */
const MAX_BATCH_ROUNDS = 3;

/**
 * Plunk Lite: a batch that failed for good -- out of attempts, or stalled more often than allowed --
 * leaves its campaign SENDING: say so, and whether the sweep will try it again
 */
export async function onCampaignBatchFailed(job: Job<CampaignBatchJobData> | undefined, error: Error): Promise<void> {
  if (!job || (error.name !== 'UnrecoverableError' && job.attemptsMade < (job.opts.attempts ?? 1))) {
    return;
  }
  const last = (job.data.sweepRetries ?? 0) >= MAX_BATCH_ROUNDS;
  await FailureAlertService.recordCampaignJob(
    job.data.campaignId,
    last ? `${error.message} (tried ${MAX_BATCH_ROUNDS + 1} times; it will not be tried again)` : error.message,
  );
}

/**
 * Plunk Lite: give the batches that failed for good another round, while their campaign is still
 * sending the same send, up to 3 rounds. A batch is idempotent (its emails' ids come from the send,
 * and each is created under the campaign's lock), so running it again only creates what is missing.
 */
export async function retryFailedCampaignBatches(): Promise<number> {
  const failed = (await campaignQueue.getFailed()).filter(job => job);
  if (failed.length === 0) {
    return 0;
  }
  const sending = new Map(
    (
      await prisma.campaign.findMany({
        where: {id: {in: [...new Set(failed.map(job => job.data.campaignId))]}, status: CampaignStatus.SENDING},
        select: {id: true, sentAt: true},
      })
    ).map(campaign => [campaign.id, campaign.sentAt?.getTime()]),
  );

  let retried = 0;
  for (const job of failed) {
    if (sending.get(job.data.campaignId) === job.data.generation && (job.data.sweepRetries ?? 0) < MAX_BATCH_ROUNDS) {
      await QueueService.retryForAnotherRound(job);
      retried++;
    }
  }
  if (retried > 0) {
    signale.warn(`[CAMPAIGN-PROCESSOR] Retrying ${retried} failed campaign batch(es)`);
  }
  return retried;
}

export function createCampaignWorker() {
  const worker = new Worker<CampaignBatchJobData>(
    campaignQueue.name,
    async (job: Job<CampaignBatchJobData>) => {
      const {campaignId, batchNumber} = job.data;

      signale.info(`[CAMPAIGN-PROCESSOR] Processing batch ${batchNumber} for campaign ${campaignId}`);

      await CampaignService.processBatch(job.data);

      signale.info(`[CAMPAIGN-PROCESSOR] Completed batch ${batchNumber} for campaign ${campaignId}`);
    },
    {
      connection: campaignQueue.opts.connection,
      concurrency: 5, // Process up to 5 batches concurrently
      // Plunk Lite: a batch is idempotent, so one cut short by restarts may run again a few times
      maxStalledCount: 3,
    },
  );

  worker.on('completed', job => {
    signale.info(`[CAMPAIGN-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[CAMPAIGN-PROCESSOR] Job ${job?.id} failed:`, err.message);
    void onCampaignBatchFailed(job, err);
  });

  worker.on('error', err => {
    signale.error('[CAMPAIGN-PROCESSOR] Worker error:', err);
  });

  return worker;
}
