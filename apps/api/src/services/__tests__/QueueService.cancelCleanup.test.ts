import {type Job, Worker} from 'bullmq';
import {beforeEach, describe, expect, it} from 'vitest';

import {campaignCancelCleanupQueue, QueueService} from '../QueueService';

/**
 * A campaign cancelled again -- after it was sent again, or to repair a cleanup that ran out of
 * attempts -- must get its cleanup run: BullMQ ignores a job whose id is still taken by a finished
 * one, and the campaign would stay CANCELLED for good.
 */
describe('QueueService.queueCampaignCancelCleanup', () => {
  const campaignId = 'campaign-cancelled-again';
  const jobId = `campaign-cancel-cleanup-${campaignId}`;
  const firstCancel = new Date('2026-10-27T10:00:00Z');
  const secondCancel = new Date('2026-10-27T11:00:00Z');

  beforeEach(async () => {
    await campaignCancelCleanupQueue.obliterate({force: true});
  });

  /** Take the cleanup job as a worker would, and finish it with `finish` */
  async function runCleanup(finish: (job: Job) => Promise<unknown>) {
    const worker = new Worker(campaignCancelCleanupQueue.name, null, {
      connection: campaignCancelCleanupQueue.opts.connection,
      autorun: false,
    });
    try {
      const job = await worker.getNextJob('test-token');
      await finish(job!);
    } finally {
      await worker.close();
    }
  }

  it('queues the cleanup again once the earlier one has completed', async () => {
    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', firstCancel);
    await runCleanup(job => job.moveToCompleted({deleted: 0, status: 'DRAFT'}, 'test-token', false));

    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', secondCancel);

    const job = await campaignCancelCleanupQueue.getJob(jobId);
    expect(await job!.getState()).toBe('waiting');
    expect(job!.data.cancelledAt).toBe(secondCancel.toISOString());
  });

  it('queues the cleanup again once the earlier one has failed for good', async () => {
    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', firstCancel);
    await runCleanup(async job => {
      // Out of attempts, as after a cleanup that kept finding rows it could not clear
      job.discard();
      await job.moveToFailed(new Error('Campaign still has unsent emails after its cleanup'), 'test-token');
    });

    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', secondCancel);

    const job = await campaignCancelCleanupQueue.getJob(jobId);
    expect(await job!.getState()).toBe('waiting');
    expect(job!.data.cancelledAt).toBe(secondCancel.toISOString());
  });

  it('leaves a pending cleanup alone, rather than starting a second one over the same rows', async () => {
    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', firstCancel);

    await QueueService.queueCampaignCancelCleanup(campaignId, 'project', secondCancel);

    const job = await campaignCancelCleanupQueue.getJob(jobId);
    expect(job!.data.cancelledAt).toBe(firstCancel.toISOString());
    expect((await campaignCancelCleanupQueue.getJobCounts('waiting')).waiting).toBe(1);
  });
});
