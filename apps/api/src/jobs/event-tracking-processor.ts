/**
 * Event Tracking Worker
 * Tracks the SES events the SNS webhook received, and the unsubscribe a bounce or complaint
 * causes: records the event, starts the workflows that listen for it and resumes the ones waiting
 * for it
 */

import {Prisma} from '@plunk/db';
import type {EventTrackingJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {EventService} from '../services/EventService.js';
import {eventTrackingQueue} from '../services/QueueService.js';

export async function processEventTracking(job: Job<EventTrackingJobData>): Promise<void> {
  const {projectId, eventName, contactId, emailId, data, followUp} = job.data;
  const failures: unknown[] = [];
  try {
    await EventService.trackEvent(projectId, eventName, contactId, emailId, data);
  } catch (error) {
    failures.push(error);
  }

  // Tracked even when the first failed: a workflow that mirrors unsubscribes elsewhere must still
  // hear that the contact is off the list
  if (followUp) {
    try {
      await trackFollowUp(job.data, followUp);
    } catch (error) {
      // The worker's log names the job by its first event, so this one is named here
      signale.error(`[EVENT-TRACKING-WORKER] Job ${job.id}: tracking ${followUp.eventName} failed:`, error);
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

/**
 * The email can be gone by now -- deleted with its campaign -- and the event fails on it. The
 * unsubscribe still stands, so it is tracked without the email. Only when the email is gone: then
 * the event was never written, and tracking it again cannot track it twice.
 */
async function trackFollowUp(
  {projectId, contactId, emailId}: EventTrackingJobData,
  followUp: NonNullable<EventTrackingJobData['followUp']>,
): Promise<void> {
  try {
    await EventService.trackEvent(projectId, followUp.eventName, contactId, emailId, followUp.data);
  } catch (error) {
    const emailGone =
      emailId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003' &&
      !(await prisma.email.findUnique({where: {id: emailId}, select: {id: true}}));
    if (!emailGone) {
      throw error;
    }
    await EventService.trackEvent(projectId, followUp.eventName, contactId, undefined, followUp.data);
  }
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
