import type {Job} from 'bullmq';
import {Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {onPlunkLiteCheckFailed} from '../../jobs/plunk-lite-checks-processor';
import {plunkLiteChecksQueue, QueueService} from '../QueueService';
import {ReputationCheck} from '../ReputationCheck';
import {SecurityService} from '../SecurityService';
import {SourceBrakeService} from '../SourceBrakeService';

/**
 * Plunk Lite: the reputation check after a bounce or complaint runs in a job, once for a burst of
 * them, and a check that cannot read the rates is retried instead of passing the project as healthy.
 */
describe('ReputationCheck', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    await plunkLiteChecksQueue.obliterate({force: true});
    await redis.flushdb();
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const transactional = () => ({projectId, campaignId: null, workflowExecutionId: null});
  /** What the events since the last check brought, still waiting for one */
  const pendingItems = async () => (await redis.zrange(`plunk-lite:security:pending-z:${projectId}`, 0, -1)).sort();

  /** Take the waiting check as a worker would */
  async function takeCheck(worker: Worker): Promise<Job> {
    const [delayed] = await plunkLiteChecksQueue.getDelayed();
    await delayed!.promote();
    return (await worker.getNextJob('test-token')) as Job;
  }

  it('leaves one check waiting for a burst of bounces and complaints, and judges what they all moved', async () => {
    for (let i = 0; i < 20; i++) {
      await ReputationCheck.afterEvent(transactional(), i === 7 ? 'complaint' : 'bounce');
    }

    const delayed = await plunkLiteChecksQueue.getDelayed();
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.data).toEqual({projectId, trigger: 'bounce'});

    const enforce = vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();
    await ReputationCheck.run(delayed[0]!.data);
    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce', 'complaint'], {withoutRedis: false});
  });

  it('queues the check again when the job its deduplication points to is gone', async () => {
    const first = await QueueService.queueSecurityCheck({projectId, trigger: 'bounce'});
    expect((await QueueService.queueSecurityCheck({projectId, trigger: 'bounce'})).id).toBe(first.id);
    // Removed by hand, leaving its deduplication key behind
    const client = await plunkLiteChecksQueue.client;
    await client.del(plunkLiteChecksQueue.toKey(first.id!));
    await client.zrem(plunkLiteChecksQueue.toKey('delayed'), first.id!);

    const again = await QueueService.queueSecurityCheck({projectId, trigger: 'complaint'});

    expect(again.id).not.toBe(first.id);
    const delayed = await plunkLiteChecksQueue.getDelayed();
    expect(delayed.map(job => job.data)).toEqual([{projectId, trigger: 'complaint'}]);
    // And deduplicates the ones after it as before
    expect((await QueueService.queueSecurityCheck({projectId, trigger: 'bounce'})).id).toBe(again.id);
  });

  it('judges the campaigns and workflows of the burst, then the project', async () => {
    const campaign = await factories.createCampaign({projectId});
    const workflow = await factories.createWorkflow({projectId});
    const contact = await factories.createContact({projectId});
    const execution = await factories.createWorkflowExecution(workflow.id, contact.id);
    await ReputationCheck.afterEvent({projectId, campaignId: campaign.id, workflowExecutionId: null}, 'bounce');
    await ReputationCheck.afterEvent({projectId, campaignId: null, workflowExecutionId: execution.id}, 'complaint');

    const [check] = await plunkLiteChecksQueue.getDelayed();
    expect(check!.data).toEqual({projectId, trigger: 'bounce', source: `campaign:${campaign.id}`});

    const order: string[] = [];
    const brake = vi.spyOn(SourceBrakeService, 'brake').mockImplementation(async () => void order.push('sources'));
    vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockImplementation(
      async () => void order.push('project'),
    );
    await ReputationCheck.run(check!.data);

    expect(new Set(brake.mock.calls[0]![1])).toEqual(new Set([`campaign:${campaign.id}`, `workflow:${workflow.id}`]));
    expect(order).toEqual(['sources', 'project']);
  });

  it('checks the project even when judging a source failed, and then fails to be tried again', async () => {
    const campaign = await factories.createCampaign({projectId});
    await ReputationCheck.afterEvent({projectId, campaignId: campaign.id, workflowExecutionId: null}, 'bounce');
    vi.spyOn(SourceBrakeService, 'brake').mockRejectedValue(new Error('database down'));
    const enforce = vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();

    await expect(ReputationCheck.run({projectId, trigger: 'bounce'})).rejects.toThrow('database down');

    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce'], {withoutRedis: false});
    // Left for the next attempt
    expect(await pendingItems()).toEqual([`campaign:${campaign.id}`, 'trigger:bounce'].sort());
  });

  it('removes what it judged once it has, and keeps what was noted again while it ran', async () => {
    const campaign = await factories.createCampaign({projectId});
    const other = await factories.createCampaign({projectId});
    await ReputationCheck.afterEvent({projectId, campaignId: campaign.id, workflowExecutionId: null}, 'bounce');
    await ReputationCheck.afterEvent({projectId, campaignId: other.id, workflowExecutionId: null}, 'bounce');
    vi.spyOn(QueueService, 'queueSecurityCheck').mockResolvedValue({} as never);
    // A bounce of the same campaign arrives while the check judges it
    vi.spyOn(SourceBrakeService, 'brake').mockImplementation(async () => {
      await ReputationCheck.afterEvent({projectId, campaignId: campaign.id, workflowExecutionId: null}, 'complaint');
    });
    vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();

    await ReputationCheck.run({projectId, trigger: 'bounce'});

    expect(await pendingItems()).toEqual([`campaign:${campaign.id}`, 'trigger:complaint'].sort());
  });

  it('merges what the plain set of before kept into the first check after the update', async () => {
    const campaign = await factories.createCampaign({projectId});
    await redis.sadd(`plunk-lite:security:pending:${projectId}`, `campaign:${campaign.id}`, 'trigger:complaint');
    const brake = vi.spyOn(SourceBrakeService, 'brake').mockResolvedValue();
    const enforce = vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();

    await ReputationCheck.run({projectId, trigger: 'bounce'});

    expect(brake).toHaveBeenCalledWith(projectId, [`campaign:${campaign.id}`]);
    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce', 'complaint'], {withoutRedis: false});
    expect(await redis.exists(`plunk-lite:security:pending:${projectId}`)).toBe(0);
    expect(await pendingItems()).toEqual([]);
  });

  it('judges every campaign still sending when the sources of the burst cannot be read', async () => {
    const sending = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    await factories.createCampaign({projectId, status: CampaignStatus.SENT});
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('Redis down'));
    const brake = vi.spyOn(SourceBrakeService, 'brake').mockResolvedValue();
    vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();

    await ReputationCheck.run({projectId, trigger: 'bounce'});

    expect(brake).toHaveBeenCalledWith(projectId, [`campaign:${sending.id}`]);
  });

  it('queues another check after the one running when a bounce arrives during it', async () => {
    const worker = new Worker(plunkLiteChecksQueue.name, null, {
      connection: plunkLiteChecksQueue.opts.connection,
      autorun: false,
    });
    try {
      await ReputationCheck.afterEvent(transactional(), 'bounce');
      const running = await takeCheck(worker);

      await ReputationCheck.afterEvent(transactional(), 'complaint');
      expect(await plunkLiteChecksQueue.getDelayed()).toHaveLength(0);

      await running.moveToCompleted(undefined, 'test-token', false);

      const delayed = await plunkLiteChecksQueue.getDelayed();
      expect(delayed.map(job => job.data)).toEqual([{projectId, trigger: 'complaint'}]);
    } finally {
      await worker.close();
    }
  });

  it('does not pass the project as healthy when the rates cannot be read: the check fails, keeping its events', async () => {
    await ReputationCheck.afterEvent(transactional(), 'complaint');
    vi.spyOn(SecurityService as never, 'calculateSecurityStatus').mockRejectedValue(new Error('database down'));

    await expect(ReputationCheck.run({projectId, trigger: 'bounce'})).rejects.toThrow('database down');

    expect(await pendingItems()).toEqual(['trigger:complaint']);
    expect((await prisma.project.findUniqueOrThrow({where: {id: projectId}})).disabled).toBe(false);
  });

  it('runs the check at once when it cannot be queued, and never fails the event', async () => {
    vi.spyOn(QueueService, 'queueSecurityCheck').mockRejectedValue(new Error('Redis down'));
    const enforce = vi
      .spyOn(SecurityService, 'checkAndEnforceSecurityLimits')
      .mockRejectedValue(new Error('database down'));

    await expect(ReputationCheck.afterEvent(transactional(), 'bounce')).resolves.toBeUndefined();

    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce'], {withoutRedis: false});
    // Nothing is watching the project's rates: it is told so
    const failure = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}});
    expect(failure).toMatchObject({sourceKey: 'security:check', label: 'Sending reputation check'});
    expect(failure.lastError).toContain('database down');
  });

  it('runs the check at once when queueing it hangs, as BullMQ does while Redis is down', async () => {
    vi.spyOn(QueueService, 'queueSecurityCheck').mockReturnValue(new Promise<never>(() => undefined));
    const enforce = vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();

    const started = Date.now();
    await ReputationCheck.afterEvent(transactional(), 'complaint');

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(enforce).toHaveBeenCalledWith(projectId, ['complaint'], {withoutRedis: false});
    expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
  });

  describe('with Redis down', () => {
    /**
     * A campaign still sending past its brake, and the project past disabling, but reactivated after
     * those bounces: read, its grace period keeps them from disabling it
     */
    async function bouncedAfterReactivation() {
      const contact = await factories.createContact({projectId});
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      const createdAt = new Date(Date.now() - 60_000);
      await prisma.email.createMany({
        data: Array.from({length: 300}, (_, i) => ({
          projectId,
          contactId: contact.id,
          campaignId: campaign.id,
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'hi@example.com',
          sourceType: EmailSourceType.CAMPAIGN,
          status: EmailStatus.SENT,
          sentAt: createdAt,
          createdAt,
          bouncedAt: i < 30 ? createdAt : null,
        })),
      });
      await redis.set(`plunk-lite:reactivated:${projectId}`, JSON.stringify({reactivatedAt: new Date()}), 'EX', 3600);
      return campaign;
    }

    /** Runs `fn` with the Redis client reading as reconnecting */
    async function whileReconnecting(fn: () => Promise<void>) {
      const status = redis.status;
      (redis as {status: string}).status = 'reconnecting';
      try {
        await fn();
      } finally {
        (redis as {status: string}).status = status;
      }
    }

    const project = () => prisma.project.findUniqueOrThrow({where: {id: projectId}});

    it('runs the check at once without it, and still stops the campaign and the project', async () => {
      const campaign = await bouncedAfterReactivation();
      vi.spyOn(QueueService, 'queueSecurityCheck').mockRejectedValue(new Error('Redis down'));
      const noted = vi.spyOn(redis, 'eval');
      const commands = (['get', 'set', 'setex', 'multi', 'smembers', 'zremrangebyscore'] as const).map(name =>
        vi.spyOn(redis, name),
      );

      await whileReconnecting(() =>
        ReputationCheck.afterEvent({projectId, campaignId: campaign.id, workflowExecutionId: null}, 'bounce'),
      );

      // Only noting the event was tried, bounded; the check read and wrote nothing there
      expect(noted).toHaveBeenCalledOnce();
      for (const command of commands) {
        expect(command).not.toHaveBeenCalled();
      }
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );
      expect(await project()).toMatchObject({disabled: true, disabledReason: 'EMAIL_REPUTATION'});
    });

    it('fails the job, to be tried again, instead of judging the project without its grace period', async () => {
      const campaign = await bouncedAfterReactivation();
      const data = {projectId, trigger: 'bounce' as const, source: `campaign:${campaign.id}`};

      await whileReconnecting(async () => {
        await expect(ReputationCheck.run(data)).rejects.toThrow('Redis is not connected');
      });
      expect((await project()).disabled).toBe(false);

      // Tried again once Redis is back: the grace period counts
      await ReputationCheck.run(data);
      expect((await project()).disabled).toBe(false);
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );
    });
  });

  it('gives up on the check run at once after ten seconds, and tells the project', async () => {
    vi.spyOn(QueueService, 'queueSecurityCheck').mockRejectedValue(new Error('Redis down'));
    const enforce = vi
      .spyOn(SecurityService, 'checkAndEnforceSecurityLimits')
      .mockReturnValue(new Promise<never>(() => undefined));
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});

    const done = ReputationCheck.afterEvent(transactional(), 'bounce');
    await vi.waitFor(() => expect(enforce).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    const failure = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}});
    expect(failure).toMatchObject({sourceKey: 'security:check'});
    expect(failure.lastError).toContain('did not finish within 10 seconds, and may complete later');
  });

  it('tells the project once a check has run out of attempts, and not before', async () => {
    const job = (attemptsMade: number) =>
      ({name: 'security-check', attemptsMade, opts: {attempts: 5}, data: {projectId, trigger: 'bounce'}}) as Job;

    await onPlunkLiteCheckFailed(job(4), new Error('database down'));
    expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);

    await onPlunkLiteCheckFailed(job(5), new Error('database down'));
    const failure = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}});
    expect(failure).toMatchObject({sourceKey: 'security:check', label: 'Sending reputation check'});
    expect(failure.lastError).toContain('database down');
  });
});
