import {randomUUID} from 'node:crypto';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {prisma as appPrisma} from '../../database/prisma';
import {redis} from '../../database/redis';
import {QueueService} from '../../services/QueueService';
import {SecurityService} from '../../services/SecurityService';
import {getAwsAccountId} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {notification, OWN_TOPIC, postSns} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
}));

/**
 * Copies of one SNS message. SNS delivers at least once, and an open, a click or a delivery
 * counted per copy: the counters went up again and the event was queued again once its job had
 * left the queue. Each message is now handled once, by its MessageId.
 */
describe('Webhooks - duplicate SNS deliveries of an event', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
    vi.spyOn(SnsSignature, 'verify').mockResolvedValue('valid');
    vi.mocked(getAwsAccountId).mockResolvedValue('111111111111');
    vi.spyOn(QueueService, 'queueEventTracking').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sentEmail = (messageId: string) =>
    prisma.email.create({
      data: {
        projectId,
        contactId,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'TRANSACTIONAL',
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId,
      },
    });

  /** One SNS message, which every copy repeats with its MessageId */
  const snsMessage = (event: Record<string, unknown>) => {
    const body = {Type: 'Notification', TopicArn: OWN_TOPIC, MessageId: randomUUID(), Message: JSON.stringify(event)};
    return () => postSns(body);
  };

  it('counts an open delivered twice once', async () => {
    const email = await sentEmail('ses-open-twice');
    const deliver = snsMessage(notification('Open', 'ses-open-twice', {open: {}}));

    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);

    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).opens).toBe(1);
    expect(QueueService.queueEventTracking).toHaveBeenCalledOnce();
  });

  it('does not queue a click again once its job has left the queue', async () => {
    const email = await sentEmail('ses-click-again');
    const deliver = snsMessage(notification('Click', 'ses-click-again', {click: {link: 'https://example.com'}}));

    await deliver();
    // What the queue's own jobId could not stop: the first job is done and gone
    vi.mocked(QueueService.queueEventTracking).mockClear();
    await deliver();

    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).clicks).toBe(1);
    expect(QueueService.queueEventTracking).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', () => vi.spyOn(appPrisma.email, 'update').mockRejectedValueOnce(new Error('database down'))],
    ['a 503', () => vi.spyOn(SecurityService, 'snsTopicOrigin').mockResolvedValueOnce('unknown')],
  ])('handles the next copy after %s', async (_case, failOnce) => {
    const email = await sentEmail(`ses-delivery-${randomUUID()}`);
    const deliver = snsMessage(notification('Delivery', email.messageId!));
    failOnce();

    expect((await deliver()).status).toBeGreaterThanOrEqual(500);
    expect((await deliver()).status).toBe(200);

    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).deliveredAt).not.toBeNull();
  });

  it('answers 503 to a copy that arrives while another is being handled', async () => {
    const email = await sentEmail('ses-open-together');
    const deliver = snsMessage(notification('Open', 'ses-open-together', {open: {}}));

    const responses = await Promise.all([deliver(), deliver()]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 503]);
    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).opens).toBe(1);
  });

  it('handles the message anyway when Redis cannot say whether it was', async () => {
    const email = await sentEmail('ses-open-no-redis');
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));

    expect((await snsMessage(notification('Open', 'ses-open-no-redis', {open: {}}))()).status).toBe(200);

    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).opens).toBe(1);
  });

  it('leaves bounces to the claim on the email row, without remembering their message', async () => {
    vi.spyOn(SecurityService, 'checkAndEnforceSecurityLimits').mockResolvedValue();
    await sentEmail('ses-bounce-row-claim');
    const messageId = randomUUID();

    await postSns({
      Type: 'Notification',
      TopicArn: OWN_TOPIC,
      MessageId: messageId,
      Message: JSON.stringify(notification('Bounce', 'ses-bounce-row-claim', {bounce: {bounceType: 'Permanent'}})),
    });

    expect(await redis.exists(`plunk-lite:sns:msg:${messageId}`)).toBe(0);
  });
});
