/**
 * Background Job: Scheduled Campaign Processor
 * Processes scheduled campaigns when their time arrives
 */

import {CampaignStatus} from '@plunk/db';
import type {ScheduledCampaignJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {CampaignService} from '../services/CampaignService.js';
import {scheduledQueue} from '../services/QueueService.js';

export function createScheduledCampaignWorker() {
  const worker = new Worker<ScheduledCampaignJobData>(
    scheduledQueue.name,
    async (job: Job<ScheduledCampaignJobData>) => {
      const {campaignId} = job.data;

      signale.info(`[SCHEDULED-PROCESSOR] Processing scheduled campaign ${campaignId}`);

      // Get campaign with project
      const campaign = await prisma.campaign.findUnique({
        where: {id: campaignId},
        include: {
          project: {
            select: {disabled: true, id: true, name: true},
          },
        },
      });

      if (!campaign) {
        signale.warn(`[SCHEDULED-PROCESSOR] Campaign ${campaignId} not found, skipping`);
        return;
      }

      // Check if project is disabled
      if (campaign.project.disabled) {
        signale.warn(
          `[SCHEDULED-PROCESSOR] Project ${campaign.projectId} (${campaign.project.name}) is disabled, cancelling campaign ${campaignId}`,
        );
        await prisma.campaign.update({
          where: {id: campaignId},
          data: {status: CampaignStatus.CANCELLED},
        });
        return;
      }

      // Verify campaign is still in SCHEDULED status
      if (campaign.status !== CampaignStatus.SCHEDULED) {
        signale.warn(
          `[SCHEDULED-PROCESSOR] Campaign ${campaignId} is not in SCHEDULED status (${campaign.status}), skipping`,
        );
        return;
      }

      // Start sending the campaign
      // Only from SCHEDULED: a schedule cancelled back to a draft as this fired stays a draft
      await CampaignService.startSending(campaign.projectId, campaignId, undefined, [CampaignStatus.SCHEDULED]);

      signale.info(`[SCHEDULED-PROCESSOR] Started sending campaign ${campaignId}`);
    },
    {
      connection: scheduledQueue.opts.connection,
      concurrency: 2, // Process up to 2 scheduled campaigns concurrently
    },
  );

  worker.on('completed', job => {
    signale.info(`[SCHEDULED-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[SCHEDULED-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[SCHEDULED-PROCESSOR] Worker error:', err);
  });

  return worker;
}
