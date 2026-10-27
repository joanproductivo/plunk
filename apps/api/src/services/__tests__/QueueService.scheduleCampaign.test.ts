import {Worker} from 'bullmq';
import {beforeEach, describe, expect, it} from 'vitest';

import {QueueService, scheduledQueue} from '../QueueService';

/**
 * A campaign scheduled again after its schedule could not start must get a new job: BullMQ
 * ignores a job whose id is still taken by a failed one.
 */
describe('QueueService.scheduleCampaign', () => {
  beforeEach(async () => {
    await scheduledQueue.obliterate({force: true});
  });

  it('replaces the waiting job of an earlier schedule', async () => {
    const campaignId = 'campaign-moved';
    await QueueService.scheduleCampaign(campaignId, new Date(Date.now() + 60 * 60 * 1000));

    const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await QueueService.scheduleCampaign(campaignId, later);

    const job = await scheduledQueue.getJob(`scheduled-campaign-${campaignId}`);
    // Delayed until the new time, not the old one
    expect(job!.opts.delay).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  it('replaces the failed job of an earlier schedule', async () => {
    const campaignId = 'campaign-rescheduled';
    await QueueService.scheduleCampaign(campaignId, new Date());
    // The start failed and the job was failed, as the processor does for a campaign that cannot start
    const worker = new Worker(scheduledQueue.name, null, {connection: scheduledQueue.opts.connection, autorun: false});
    try {
      const job = await worker.getNextJob('test-token');
      await job!.moveToFailed(new Error('Referenced segment not found'), 'test-token');
    } finally {
      await worker.close();
    }

    const later = new Date(Date.now() + 60 * 60 * 1000);
    await QueueService.scheduleCampaign(campaignId, later);

    const job = await scheduledQueue.getJob(`scheduled-campaign-${campaignId}`);
    expect(await job!.getState()).toBe('delayed');
  });
});
