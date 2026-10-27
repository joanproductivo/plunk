/**
 * Unified Queue Worker
 * Starts all queue processors (email, campaign, scheduled, workflow, import, segment-count, domain-verification)
 *
 * This should be run as a separate process in production:
 * node dist/jobs/worker.js
 */

import {Worker} from 'bullmq';
import signale from 'signale';

import {SHUTDOWN_TIMEOUT_MS} from '../app/constants.js';

import {createApiRequestCleanupWorker} from './api-request-cleanup-processor.js';
import {buildBackgroundIndexes} from './background-index-builder.js';
import {createIdempotencyKeyCleanupWorker} from './idempotency-key-cleanup-processor.js';
import {createBulkContactWorker} from './bulk-contact-processor.js';
import {createCampaignCancelCleanupWorker} from './campaign-cancel-cleanup-processor.js';
import {createCampaignWorker} from './campaign-processor.js';
import {createCardVerificationWorker} from './card-verification-processor.js';
import {createCampaignStatsSweepWorker} from './campaign-stats-sweep-processor.js';
import {createSnoozeSweepWorker} from './snooze-sweep-processor.js';
import {createCardVerificationSweepWorker} from './card-verification-sweep-processor.js';
import {createDomainVerificationWorker} from './domain-verification-processor.js';
import {createEmailBodyCleanupWorker} from './email-body-cleanup-processor.js';
import {createEmailWorker} from './email-processor.js';
import {createImportWorker} from './import-processor.js';
import {createMeterWorker} from './meter-processor.js';
import {createScheduledCampaignWorker} from './scheduled-processor.js';
import {createSegmentCountWorker} from './segment-count-processor.js';
import {createSegmentMembershipEventsWorker} from './segment-membership-events-processor.js';
import {createWorkflowWorker} from './workflow-processor-queue.js';

const workers: {name: string; worker: Worker}[] = [];

async function startWorkers() {
  signale.info('[WORKER] Starting queue workers...');

  try {
    // Start email worker
    const emailWorker = await createEmailWorker();
    workers.push({name: 'email', worker: emailWorker});
    signale.success('[WORKER] Email worker started');

    // Start campaign worker
    const campaignWorker = createCampaignWorker();
    workers.push({name: 'campaign', worker: campaignWorker});
    signale.success('[WORKER] Campaign worker started');

    // Start campaign cancel cleanup worker
    const campaignCancelCleanupWorker = createCampaignCancelCleanupWorker();
    workers.push({name: 'campaign-cancel-cleanup', worker: campaignCancelCleanupWorker});
    signale.success('[WORKER] Campaign cancel cleanup worker started');

    // Start campaign stats reconcile sweep worker
    const campaignStatsSweepWorker = createCampaignStatsSweepWorker();
    workers.push({name: 'campaign-stats-sweep', worker: campaignStatsSweepWorker});
    signale.success('[WORKER] Campaign stats sweep worker started');

    // Start snooze sweep worker
    const snoozeSweepWorker = createSnoozeSweepWorker();
    workers.push({name: 'snooze-sweep', worker: snoozeSweepWorker});
    signale.success('[WORKER] Snooze sweep worker started');

    // Start scheduled campaign worker
    const scheduledWorker = createScheduledCampaignWorker();
    workers.push({name: 'scheduled', worker: scheduledWorker});
    signale.success('[WORKER] Scheduled campaign worker started');

    // Start workflow worker
    const workflowWorker = createWorkflowWorker();
    workers.push({name: 'workflow', worker: workflowWorker});
    signale.success('[WORKER] Workflow worker started');

    // Start import worker
    const importWorker = createImportWorker();
    workers.push({name: 'import', worker: importWorker});
    signale.success('[WORKER] Import worker started');

    // Start bulk contact action worker
    const bulkContactWorker = createBulkContactWorker();
    workers.push({name: 'bulk-contact-actions', worker: bulkContactWorker});
    signale.success('[WORKER] Bulk contact action worker started');

    // Start segment count worker
    const segmentCountWorker = createSegmentCountWorker();
    workers.push({name: 'segment-count', worker: segmentCountWorker});
    signale.success('[WORKER] Segment count worker started');

    // Start domain verification worker
    const domainVerificationWorker = createDomainVerificationWorker();
    workers.push({name: 'domain-verification', worker: domainVerificationWorker});
    signale.success('[WORKER] Domain verification worker started');

    // Start API request cleanup worker
    const apiRequestCleanupWorker = createApiRequestCleanupWorker();
    workers.push({name: 'api-request-cleanup', worker: apiRequestCleanupWorker});
    signale.success('[WORKER] API request cleanup worker started');

    // Start idempotency key cleanup worker
    const idempotencyKeyCleanupWorker = createIdempotencyKeyCleanupWorker();
    workers.push({name: 'idempotency-key-cleanup', worker: idempotencyKeyCleanupWorker});
    signale.success('[WORKER] Idempotency key cleanup worker started');

    // Start email body cleanup worker
    const emailBodyCleanupWorker = createEmailBodyCleanupWorker();
    workers.push({name: 'email-body-cleanup', worker: emailBodyCleanupWorker});
    signale.success('[WORKER] Email body cleanup worker started');

    // Start meter worker
    const meterWorker = createMeterWorker();
    workers.push({name: 'meter', worker: meterWorker});
    signale.success('[WORKER] Meter worker started');

    // Start card verification worker
    const cardVerificationWorker = createCardVerificationWorker();
    workers.push({name: 'card-verification', worker: cardVerificationWorker});
    signale.success('[WORKER] Card verification worker started');

    // Start card verification sweep worker
    const cardVerificationSweepWorker = createCardVerificationSweepWorker();
    workers.push({name: 'card-verification-sweep', worker: cardVerificationSweepWorker});
    signale.success('[WORKER] Card verification sweep worker started');

    // Start segment membership events worker
    const segmentMembershipEventsWorker = createSegmentMembershipEventsWorker();
    workers.push({name: 'segment-membership-events', worker: segmentMembershipEventsWorker});
    signale.success('[WORKER] Segment membership events worker started');

    signale.success('[WORKER] All workers started successfully');

    // Not awaited: index builds can take a long time and must not hold up job processing
    void buildBackgroundIndexes();
  } catch (error) {
    signale.error('[WORKER] Failed to start workers:', error);
    process.exit(1);
  }
}

let stopping = false;

async function stopWorkers() {
  // A second signal, or an error raised while closing, must not start a second close
  if (stopping) {
    return;
  }
  stopping = true;

  signale.info('[WORKER] Stopping workers...');

  const deadline = setTimeout(() => {
    signale.error(`[WORKER] Workers did not stop within ${SHUTDOWN_TIMEOUT_MS / 1000}s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Closed together: each close waits for that queue's active jobs, so closing them one
  // after another would add up every queue's wait and run past the kill timeout
  await Promise.allSettled(
    workers.map(async ({name, worker}) => {
      try {
        await worker.close();
        signale.info(`[WORKER] ${name} worker stopped`);
      } catch (error) {
        signale.error(`[WORKER] Error stopping ${name} worker:`, error);
      }
    }),
  );

  signale.success('[WORKER] All workers stopped');
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  signale.info('[WORKER] Received SIGINT, shutting down gracefully...');
  void stopWorkers();
});

process.on('SIGTERM', () => {
  signale.info('[WORKER] Received SIGTERM, shutting down gracefully...');
  void stopWorkers();
});

process.on('uncaughtException', error => {
  signale.error('[WORKER] Uncaught exception:', error);
  void stopWorkers();
});

process.on('unhandledRejection', (reason, promise) => {
  signale.error('[WORKER] Unhandled rejection at:', promise, 'reason:', reason);
  void stopWorkers();
});

// Start workers
void startWorkers();
