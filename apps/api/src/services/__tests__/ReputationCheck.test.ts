import type {Job} from 'bullmq';
import {Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {onPlunkLiteCheckFailed} from '../../jobs/plunk-lite-checks-processor';
import {plunkLiteChecksQueue, QueueService} from '../QueueService';
import {ReputationCheck} from '../ReputationCheck';
import {SecurityService} from '../SecurityService';

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

  /** Take the waiting check as a worker would */
  async function takeCheck(worker: Worker): Promise<Job> {
    const [delayed] = await plunkLiteChecksQueue.getDelayed();
    await delayed!.promote();
    return (await worker.getNextJob('test-token')) as Job;
  }

  it('leaves one check waiting for a burst of bounces and complaints, and judges what they all moved', async () => {
    for (let i = 0; i < 20; i++) {
      await ReputationCheck.afterEvent({projectId}, i === 7 ? 'complaint' : 'bounce');
    }

    const delayed = await plunkLiteChecksQueue.getDelayed();
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.data).toEqual({projectId, trigger: 'bounce'});

    const enforce = vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();
    await ReputationCheck.run(delayed[0]!.data);
    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce', 'complaint']);
  });

  it('queues another check after the one running when a bounce arrives during it', async () => {
    const worker = new Worker(plunkLiteChecksQueue.name, null, {
      connection: plunkLiteChecksQueue.opts.connection,
      autorun: false,
    });
    try {
      await ReputationCheck.afterEvent({projectId}, 'bounce');
      const running = await takeCheck(worker);

      await ReputationCheck.afterEvent({projectId}, 'complaint');
      expect(await plunkLiteChecksQueue.getDelayed()).toHaveLength(0);

      await running.moveToCompleted(undefined, 'test-token', false);

      const delayed = await plunkLiteChecksQueue.getDelayed();
      expect(delayed.map(job => job.data)).toEqual([{projectId, trigger: 'complaint'}]);
    } finally {
      await worker.close();
    }
  });

  it('does not pass the project as healthy when the rates cannot be read: the check fails, keeping its events', async () => {
    await ReputationCheck.afterEvent({projectId}, 'complaint');
    vi.spyOn(SecurityService as never, 'calculateSecurityStatus').mockRejectedValue(new Error('database down'));

    await expect(ReputationCheck.run({projectId, trigger: 'bounce'})).rejects.toThrow('database down');

    expect(await redis.smembers(`plunk-lite:security:pending:${projectId}`)).toEqual(['trigger:complaint']);
    expect((await prisma.project.findUniqueOrThrow({where: {id: projectId}})).disabled).toBe(false);
  });

  it('runs the check at once when it cannot be queued, and never fails the event', async () => {
    vi.spyOn(QueueService, 'queueSecurityCheck').mockRejectedValue(new Error('Redis down'));
    const enforce = vi
      .spyOn(SecurityService, 'checkAndEnforceSecurityLimits')
      .mockRejectedValue(new Error('database down'));

    await expect(ReputationCheck.afterEvent({projectId}, 'bounce')).resolves.toBeUndefined();

    expect(enforce).toHaveBeenCalledWith(projectId, ['bounce']);
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
