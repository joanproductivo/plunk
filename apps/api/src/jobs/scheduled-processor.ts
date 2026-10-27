/**
 * Background Job: Scheduled Campaign Processor
 * Processes scheduled campaigns when their time arrives
 */

import {CampaignStatus} from '@plunk/db';
import type {ScheduledCampaignJobData} from '@plunk/types';
import {type Job, UnrecoverableError, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {CampaignService} from '../services/CampaignService.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {scheduledQueue} from '../services/QueueService.js';

/** How early a scheduled job may fire for its campaign's time, delays being approximate */
const RESCHEDULED_MARGIN_MS = 60_000;

/**
 * Start a scheduled campaign whose time has come, unless it has been cancelled, rescheduled or its
 * project disabled since
 */
export async function processScheduledCampaign(job: Job<ScheduledCampaignJobData>): Promise<void> {
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

  // A job of an earlier schedule, if one outlived a reschedule: the campaign goes out at the time
  // it is scheduled for now, by the job of that schedule
  if (campaign.scheduledFor && campaign.scheduledFor.getTime() > Date.now() + RESCHEDULED_MARGIN_MS) {
    signale.warn(
      `[SCHEDULED-PROCESSOR] Campaign ${campaignId} is now scheduled for ${campaign.scheduledFor.toISOString()}, skipping an earlier schedule's job`,
    );
    return;
  }

  // Start sending the campaign, only from SCHEDULED: a schedule cancelled back to a draft
  // between the check above and this call stays a draft, and is not a failure to retry
  try {
    await CampaignService.startSending(campaign.projectId, campaignId, undefined, [CampaignStatus.SCHEDULED]);
  } catch (error) {
    if (error instanceof HttpException && error.code === 400) {
      const current = await prisma.campaign.findUnique({where: {id: campaignId}, select: {status: true}});

      if (current?.status !== CampaignStatus.SCHEDULED) {
        signale.warn(`[SCHEDULED-PROCESSOR] Campaign ${campaignId} left SCHEDULED before it fired, skipping`);
        return;
      }

      // Still scheduled, so the campaign itself cannot start -- a segment deleted since it was
      // scheduled, say. Retrying cannot fix that; the operator is told instead of the campaign
      // waiting in SCHEDULED without a word.
      await FailureAlertService.recordCampaignJob(campaignId, `Scheduled campaign could not start: ${error.message}`);
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }

  signale.info(`[SCHEDULED-PROCESSOR] Started sending campaign ${campaignId}`);
}

export function createScheduledCampaignWorker() {
  const worker = new Worker<ScheduledCampaignJobData>(scheduledQueue.name, processScheduledCampaign, {
    connection: scheduledQueue.opts.connection,
    concurrency: 2, // Process up to 2 scheduled campaigns concurrently
  });

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
