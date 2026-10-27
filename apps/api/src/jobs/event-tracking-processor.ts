/**
 * Event Tracking Worker
 * Tracks the SES events the SNS webhook received: records the event, starts the workflows that
 * listen for it and resumes the ones waiting for it
 */

import type {EventTrackingJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {EventService} from '../services/EventService.js';
import {eventTrackingQueue} from '../services/QueueService.js';

export async function processEventTracking(job: Job<EventTrackingJobData>): Promise<void> {
  const {projectId, eventName, contactId, emailId, data} = job.data;
  await EventService.trackEvent(projectId, eventName, contactId, emailId, data);
}

/**
 * Create and export the event tracking worker
 */
export function createEventTrackingWorker(): Worker {
  const worker = new Worker<EventTrackingJobData>(eventTrackingQueue.name, processEventTracking, {
    connection: eventTrackingQueue.opts.connection,
    // Bounds the database work a burst of notifications causes -- 5,000 emails bring 15,000 or
    // more -- which the webhook used to do in as many requests as SNS sent at once
    concurrency: 5,
    // A job whose worker died mid-run is failed rather than run again: it may already have
    // started workflows, and running it again could send their emails twice
    maxStalledCount: 0,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[EVENT-TRACKING-WORKER] Job ${job?.id} (${job?.data.eventName}) failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[EVENT-TRACKING-WORKER] Worker error:', error);
  });

  return worker;
}
