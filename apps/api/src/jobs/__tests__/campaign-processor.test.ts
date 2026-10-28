import {CampaignStatus} from '@plunk/db';
import type {CampaignBatchJobData} from '@plunk/types';
import {type Job, UnrecoverableError, Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis.js';
import {FailureAlertService} from '../../services/FailureAlertService.js';
import {campaignQueue} from '../../services/QueueService.js';
import {onCampaignBatchFailed, retryFailedCampaignBatches} from '../campaign-processor.js';

/**
 * Plunk Lite: a campaign batch that failed for good left its campaign SENDING without a word. It is
 * now said, and the email recovery sweep gives it up to 3 more rounds while its send goes on.
 */
describe('campaign batches that failed for good', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
    await campaignQueue.obliterate({force: true});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await campaignQueue.obliterate({force: true});
  });

  async function sendingCampaign() {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    return prisma.campaign.update({where: {id: campaign.id}, data: {sentAt: new Date()}});
  }

  /** A batch job of `campaignId`, failed for good as a worker would leave it */
  async function failedBatch(data: Partial<CampaignBatchJobData> & {campaignId: string; generation: number}) {
    await campaignQueue.add('batch', {batchNumber: 1, offset: 0, limit: 500, ...data}, {attempts: 1});
    const worker = new Worker(campaignQueue.name, null, {connection: campaignQueue.opts.connection, autorun: false});
    try {
      const job = (await worker.getNextJob('test-token')) as Job<CampaignBatchJobData>;
      await job.moveToFailed(new Error('segment gone'), 'test-token', false);
      return job.id!;
    } finally {
      await worker.close();
    }
  }

  it('gives a failed batch of the current send another round', async () => {
    const campaign = await sendingCampaign();
    const id = await failedBatch({campaignId: campaign.id, generation: campaign.sentAt!.getTime()});
    // It had stalled before: BullMQ counts stalls for the job's whole life, so the round starts it at 0
    await redis.hset(`${campaignQueue.qualifiedName}:${id}`, 'stc', 4);

    expect(await retryFailedCampaignBatches()).toBe(1);

    const job = await campaignQueue.getJob(id);
    expect(await job!.getState()).toBe('waiting');
    expect(job!.data.sweepRetries).toBe(1);
    expect(job!.attemptsMade).toBe(0);
    expect(job!.stalledCounter).toBe(0);
  });

  it('leaves a batch of an earlier send, of a campaign no longer sending, or out of rounds', async () => {
    const campaign = await sendingCampaign();
    const generation = campaign.sentAt!.getTime();
    await failedBatch({campaignId: campaign.id, generation: generation - 1000});
    await failedBatch({campaignId: campaign.id, generation, sweepRetries: 3});
    const sent = await factories.createCampaign({projectId, status: CampaignStatus.SENT});
    await failedBatch({campaignId: sent.id, generation});

    expect(await retryFailedCampaignBatches()).toBe(0);
  });

  it('says so when a batch fails for good, and when it will not be tried again', async () => {
    const alert = vi.spyOn(FailureAlertService, 'recordCampaignJob').mockResolvedValue();
    const job = (data: Partial<CampaignBatchJobData>, attemptsMade: number) =>
      ({data: {campaignId: 'c', ...data}, attemptsMade, opts: {attempts: 3}}) as unknown as Job<CampaignBatchJobData>;

    await onCampaignBatchFailed(job({}, 1), new Error('a passing failure'));
    expect(alert).not.toHaveBeenCalled();

    await onCampaignBatchFailed(job({}, 1), new UnrecoverableError('job stalled more than allowable limit'));
    await onCampaignBatchFailed(job({sweepRetries: 3}, 3), new Error('segment gone'));

    expect(alert).toHaveBeenNthCalledWith(1, 'c', 'job stalled more than allowable limit');
    expect(alert).toHaveBeenNthCalledWith(2, 'c', expect.stringMatching(/will not be tried again/));
  });
});
