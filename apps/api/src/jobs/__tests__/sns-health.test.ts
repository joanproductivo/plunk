import {randomUUID} from 'node:crypto';

import type {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailSourceType, EmailStatus} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {DlqDrainService} from '../../services/DlqDrainService';
import {QueueService} from '../../services/QueueService';
import {checkEventPipeline, noteSnsRejection} from '../../services/SesEventMatch';
import {processPlunkLiteCheck} from '../plunk-lite-checks-processor';

/**
 * Plunk Lite: every 15 minutes, whether SES events reach the webhook. Both configuration sets
 * publish deliveries, so an email SES accepted an hour ago and still SENT never got its events.
 */
describe('the SES events check', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    await redis.flushdb();
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  async function sent(count: number, status: EmailStatus, createdAt: Date, {simulated = false} = {}) {
    await prisma.email.createMany({
      data: Array.from({length: count}, () => ({
        projectId,
        contactId,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hi@example.com',
        sourceType: EmailSourceType.TRANSACTIONAL,
        status,
        sentAt: createdAt,
        createdAt,
        messageId: randomUUID(),
        simulated,
      })),
    });
  }

  const notice = () => prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'sns:events'}});

  it('tells the project when 20 of 30 emails sent two hours ago have no event, with the rejected deliveries', async () => {
    await sent(20, EmailStatus.SENT, hoursAgo(2));
    await sent(10, EmailStatus.DELIVERED, hoursAgo(2));
    await noteSnsRejection('signature');
    await noteSnsRejection('signature');

    await processPlunkLiteCheck({name: 'sns-health', data: {}} as Job);

    const {label, lastError} = (await notice())!;
    expect(label).toBe('SES events not arriving');
    expect(lastError).toMatch(/^20 of the 30 emails SES accepted between 1 and 6 hours ago/);
    expect(lastError).toContain('rejected SNS deliveries in the last 6 hours: 2 for their signature');
  });

  it('says nothing with fewer than 20 emails', async () => {
    await sent(19, EmailStatus.SENT, hoursAgo(2));

    await checkEventPipeline();

    expect(await notice()).toBeNull();
  });

  it('leaves out simulated emails, those of the last hour and those older than six', async () => {
    // 10 of 25 without events: 40%, short of half
    await sent(15, EmailStatus.DELIVERED, hoursAgo(2));
    await sent(30, EmailStatus.SENT, hoursAgo(2), {simulated: true});
    await sent(30, EmailStatus.SENT, hoursAgo(0.5));
    await sent(30, EmailStatus.SENT, hoursAgo(7));
    await sent(10, EmailStatus.SENT, hoursAgo(3));

    await checkEventPipeline();

    expect(await notice()).toBeNull();
  });

  it('closes the notice once the emails get their events again', async () => {
    await sent(30, EmailStatus.SENT, hoursAgo(2));
    await checkEventPipeline();
    expect(await notice()).not.toBeNull();

    await prisma.email.updateMany({where: {projectId}, data: {status: EmailStatus.DELIVERED}});
    await checkEventPipeline();

    const closed = (await notice())!;
    expect(closed.reviewedAt).toEqual(closed.lastAt);
  });

  it.each([
    ['fewer than 20 emails', 5],
    ['no email at all', 0],
  ])('closes the notice once the project has %s in the window', async (_case, count) => {
    await sent(30, EmailStatus.SENT, hoursAgo(2));
    await checkEventPipeline();
    expect(await notice()).not.toBeNull();

    await prisma.email.deleteMany({where: {projectId}});
    await sent(count, EmailStatus.SENT, hoursAgo(2));
    await checkEventPipeline();

    const closed = (await notice())!;
    expect(closed.reviewedAt).toEqual(closed.lastAt);
  });

  describe('and the dead-letter queue', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('asks for a drain when the queue holds messages', async () => {
      vi.spyOn(DlqDrainService, 'check').mockResolvedValue(true);
      const queued = vi.spyOn(QueueService, 'queueDlqDrain').mockResolvedValue({} as never);

      await processPlunkLiteCheck({name: 'sns-health', data: {}} as Job);

      expect(queued).toHaveBeenCalledOnce();
    });

    it('asks for none when it is empty', async () => {
      vi.spyOn(DlqDrainService, 'check').mockResolvedValue(false);
      const queued = vi.spyOn(QueueService, 'queueDlqDrain').mockResolvedValue({} as never);

      await processPlunkLiteCheck({name: 'sns-health', data: {}} as Job);

      expect(queued).not.toHaveBeenCalled();
    });

    it('still checks the SES events when the drain cannot be asked for', async () => {
      vi.spyOn(DlqDrainService, 'check').mockResolvedValue(true);
      vi.spyOn(QueueService, 'queueDlqDrain').mockRejectedValue(new Error('Redis down'));
      await sent(20, EmailStatus.SENT, hoursAgo(2));

      await processPlunkLiteCheck({name: 'sns-health', data: {}} as Job);

      expect(await notice()).not.toBeNull();
    });
  });
});
