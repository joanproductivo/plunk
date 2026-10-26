/**
 * Background Job: Bulk Contact Action Processor
 * Processes bulk subscribe, unsubscribe, delete, and static segment add/remove operations
 */

import type {BulkContactActionJobData, BulkContactActionResult, BulkSegmentOperation} from '@plunk/types';
import {isBulkSegmentOperation} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ContactService} from '../services/ContactService.js';
import {bulkContactQueue} from '../services/QueueService.js';
import {BULK_SEGMENT_ACTION, SegmentMembershipService} from '../services/SegmentMembershipService.js';

const BATCH_SIZE = 100;

type BulkSegmentJobData = Extract<BulkContactActionJobData, {operation: BulkSegmentOperation}>;

function isSegmentJob(data: BulkContactActionJobData): data is BulkSegmentJobData {
  return isBulkSegmentOperation(data.operation);
}

async function applyBatch(
  data: BulkContactActionJobData,
  ids: string[],
): Promise<{changed: number; unchanged: number}> {
  const {projectId} = data;
  switch (data.operation) {
    case 'subscribe': {
      const r = await ContactService.bulkSubscribe(projectId, ids);
      return {changed: r.updated, unchanged: r.unchanged};
    }
    case 'unsubscribe': {
      const r = await ContactService.bulkUnsubscribe(projectId, ids);
      return {changed: r.updated, unchanged: r.unchanged};
    }
    case 'delete': {
      const r = await ContactService.bulkDelete(projectId, ids);
      return {changed: r.deleted, unchanged: 0};
    }
    // Entry/exit events go to their own queue, as for the HTTP routes: the batch is written in
    // milliseconds instead of waiting on every contact's workflows, and the events queue resumes
    // contact by contact
    case 'addToSegment': {
      // Every contact of the project enters, members included (they re-enter)
      const r = await SegmentMembershipService.addMembers(projectId, data.targetSegmentId, ids, {mode: 'background'});
      return {changed: r.added, unchanged: 0};
    }
    case 'removeFromSegment': {
      const r = await SegmentMembershipService.removeMembers(projectId, data.targetSegmentId, ids, {
        mode: 'background',
      });
      return {changed: r.removed, unchanged: r.matched - r.removed};
    }
  }
}

/**
 * Run a bulk contact job.
 *
 * Segment jobs save where they got to after each batch (`resume`) and a retry carries on from
 * there, because adding a member again is a new entry: starting over would queue the entries of
 * the batches already done a second time. A run cut short after writing a batch but before
 * saving its progress repeats that one batch (up to 100 contacts): an add queues its entries
 * again, and a removal finds them already gone, so it counts them as not in the segment. The
 * other operations are idempotent and restart.
 *
 * Each save rewrites the whole job data, `excludeIds` included; fine for the selections the
 * dashboard makes.
 */
export async function processBulkContactAction(job: Job<BulkContactActionJobData>): Promise<BulkContactActionResult> {
  const {projectId, operation, selector} = job.data;
  const segmentJob = isSegmentJob(job.data) ? job.data : undefined;
  const resume = segmentJob?.resume;

  if (segmentJob) {
    // Fail the job once, not every batch, if the segment went away or stopped being static
    await SegmentMembershipService.getStaticSegment(
      projectId,
      segmentJob.targetSegmentId,
      BULK_SEGMENT_ACTION[segmentJob.operation],
    );
  }

  const result: BulkContactActionResult = resume?.result ?? {
    operation,
    totalRequested: 0,
    successCount: 0,
    unchangedCount: 0,
    failureCount: 0,
    errors: [],
  };

  const runBatch = async (batchIds: string[]) => {
    try {
      const {changed, unchanged} = await applyBatch(job.data, batchIds);
      result.successCount += changed;
      result.unchangedCount += unchanged;
      const failed = batchIds.length - changed - unchanged;
      if (failed > 0) result.failureCount += failed;
    } catch (error) {
      signale.error('[BULK-CONTACT-PROCESSOR] Batch failed:', error);
      result.failureCount += batchIds.length;
      result.errors.push({
        contactId: 'batch',
        email: '',
        error: error instanceof Error ? error.message : 'Batch processing failed',
      });
    }
  };

  const saveResume = async (next: number | string, processed: number) => {
    if (segmentJob) {
      await job.updateData({...segmentJob, resume: {next, processed, result}});
    }
  };

  if (selector.mode === 'ids') {
    const {contactIds} = selector;
    result.totalRequested = contactIds.length;
    const start = typeof resume?.next === 'number' ? resume.next : 0;

    signale.info(
      `[BULK-CONTACT-PROCESSOR] Processing ${operation} for ${contactIds.length} contacts (ids mode) in project ${projectId}${
        start > 0 ? `, resuming at ${start}` : ''
      }`,
    );

    for (let i = start; i < contactIds.length; i += BATCH_SIZE) {
      const batchIds = contactIds.slice(i, i + BATCH_SIZE);
      await runBatch(batchIds);
      await saveResume(i + batchIds.length, i + batchIds.length);
      await job.updateProgress(Math.round(((i + batchIds.length) / contactIds.length) * 100));
    }
  } else {
    const where = ContactService.buildQueryWhere(projectId, selector);
    // A resumed job keeps the total it started with: the matches may have shrunk since (a
    // removal from the segment the list is filtered by takes contacts out of the filter).
    const total = resume ? result.totalRequested : await prisma.contact.count({where});
    result.totalRequested = total;

    signale.info(
      `[BULK-CONTACT-PROCESSOR] Processing ${operation} for ${total} contacts (query mode) in project ${projectId}${
        resume ? `, resuming after ${resume.processed}` : ''
      }`,
    );

    if (total === 0) {
      await job.updateProgress(100);
      return result;
    }

    // Cursor-based iteration over matching contacts. We re-evaluate the where clause
    // each batch (with id < cursor) instead of Prisma's `cursor:` because for `delete`
    // the rows we just processed disappear — a stable cursor would either skip survivors
    // or revisit deletions. Sorting by id desc + `id < lastId` is idempotent under either.
    let lastId: string | undefined = typeof resume?.next === 'string' ? resume.next : undefined;
    let processedRows = resume?.processed ?? 0;

    // Cap the loop so a runaway query (e.g. growing table) can't spin forever.
    const maxIterations = Math.ceil(total / BATCH_SIZE) + 50;
    for (let iter = 0; iter < maxIterations; iter += 1) {
      const batch = await prisma.contact.findMany({
        where: {
          ...where,
          ...(lastId ? {id: {...(where.id as object | undefined), lt: lastId}} : {}),
        },
        select: {id: true},
        orderBy: {id: 'desc'},
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      const batchIds = batch.map(c => c.id);
      lastId = batchIds[batchIds.length - 1]!;

      await runBatch(batchIds);

      processedRows += batchIds.length;
      await saveResume(lastId, processedRows);
      await job.updateProgress(Math.min(100, Math.round((processedRows / total) * 100)));

      if (batch.length < BATCH_SIZE) break;
    }
  }

  signale.info(
    `[BULK-CONTACT-PROCESSOR] ${operation} completed: ${result.successCount} succeeded, ${result.failureCount} failed`,
  );
  return result;
}

export function createBulkContactWorker() {
  const worker = new Worker<BulkContactActionJobData>(
    bulkContactQueue.name,
    async (job: Job<BulkContactActionJobData>) => processBulkContactAction(job),
    {
      connection: bulkContactQueue.opts.connection,
      concurrency: 3,
      // A job stalled by a restart runs again: segment jobs resume from their saved progress and
      // the other operations are idempotent, so surviving several restarts is safe
      maxStalledCount: 10,
    },
  );

  worker.on('completed', job => {
    signale.info(`[BULK-CONTACT-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[BULK-CONTACT-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[BULK-CONTACT-PROCESSOR] Worker error:', err);
  });

  return worker;
}
