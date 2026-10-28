import {randomUUID} from 'node:crypto';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {prisma as appPrisma} from '../../database/prisma';
import * as redisModule from '../../database/redis';
import {DlqDrainService} from '../DlqDrainService';
import {DLQ_ALARM_SOURCE} from '../dlqConstants';
import {QueueService} from '../QueueService';
import {SecurityService} from '../SecurityService';
import {getAwsAccountId} from '../SESService';
import {SnsSignature} from '../SnsSignature';
import {FOREIGN_TOPIC, OWN_TOPIC} from '../../controllers/__tests__/snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

const sqs = vi.hoisted(() => ({
  receiveMessage: vi.fn(),
  deleteMessage: vi.fn(),
  changeMessageVisibility: vi.fn(),
  getQueueAttributes: vi.fn(),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQS: class {
    receiveMessage = sqs.receiveMessage;
    deleteMessage = sqs.deleteMessage;
    changeMessageVisibility = sqs.changeMessageVisibility;
    getQueueAttributes = sqs.getQueueAttributes;
  },
}));

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  getAwsAccountId: vi.fn(),
}));

const HOUR = 60 * 60 * 1000;

/**
 * The drain of the dead-letter queue: each message SNS left there goes through the webhook itself,
 * and is deleted once handled or once it never will be
 */
describe('DlqDrainService', () => {
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
    vi.spyOn(QueueService, 'queueSecurityCheck').mockResolvedValue({} as never);
    sqs.deleteMessage.mockResolvedValue({});
    sqs.changeMessageVisibility.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const fn of Object.values(sqs)) {
      fn.mockReset();
    }
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
        sentAt: new Date(Date.now() - 2 * HOUR),
        messageId,
      },
    });

  /** A message of the queue, as SQS returns it: the SNS envelope as its body */
  const queued = (
    event: Record<string, unknown>,
    {publishedAt = new Date(), topic = OWN_TOPIC, receives = 1} = {},
  ) => ({
    MessageId: randomUUID(),
    ReceiptHandle: randomUUID(),
    Attributes: {ApproximateReceiveCount: String(receives)},
    Body: JSON.stringify({
      Type: 'Notification',
      MessageId: randomUUID(),
      TopicArn: topic,
      Message: JSON.stringify(event),
      Timestamp: publishedAt.toISOString(),
    }),
  });

  /** The queue's reads: the batches given, then empty */
  const queueHolds = (...batches: ReturnType<typeof queued>[][]) => {
    for (const batch of batches) {
      sqs.receiveMessage.mockResolvedValueOnce({Messages: batch});
    }
    sqs.receiveMessage.mockResolvedValue({Messages: []});
  };

  const failure = (sourceKey: string) =>
    prisma.plunkLiteFailure.findUnique({where: {projectId_sourceKey: {projectId, sourceKey}}});

  it('handles a bounce through the webhook, marks it and deletes it', async () => {
    const email = await sentEmail('dlq-bounce');
    const occurredAt = new Date(Date.now() - 3 * HOUR).toISOString();
    const message = queued({
      eventType: 'Bounce',
      mail: {messageId: 'dlq-bounce', timestamp: occurredAt},
      bounce: {bounceType: 'Permanent', bounceSubType: 'General', timestamp: occurredAt},
    });
    queueHolds([message]);

    const result = await DlqDrainService.drain();

    expect(result).toMatchObject({handled: 1, old: 0, retry: 0, invalid: 0, more: false});
    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).bouncedAt).not.toBeNull();
    expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(false);
    expect(QueueService.queueEventTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'email.bounce',
        data: expect.objectContaining({recoveredFromDlq: true, occurredAt}),
      }),
      expect.any(String),
    );
    expect(sqs.deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ReceiptHandle: message.ReceiptHandle}));
    expect((await failure('aws:dlq'))?.lastError).toContain('1 bounce');
  });

  it('drops an open older than a day without counting it', async () => {
    const email = await sentEmail('dlq-old-open');
    queueHolds([
      queued(
        {eventType: 'Open', mail: {messageId: 'dlq-old-open'}, open: {}},
        {publishedAt: new Date(Date.now() - 25 * HOUR)},
      ),
    ]);

    const result = await DlqDrainService.drain();

    expect(result).toMatchObject({handled: 0, old: 1});
    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).opens).toBe(0);
    expect(sqs.deleteMessage).toHaveBeenCalledOnce();
    expect((await failure('aws:dlq'))?.lastError).toContain('Dropped as older than 24 hours: 1 open');
  });

  it('never gives up on a message the webhook asks to have again, and waits longer each time', async () => {
    await sentEmail('dlq-retry');
    vi.spyOn(SecurityService, 'snsTopicOrigin').mockResolvedValue('unknown');
    queueHolds([queued({eventType: 'Delivery', mail: {messageId: 'dlq-retry'}, delivery: {}}, {receives: 6})]);

    const result = await DlqDrainService.drain();

    expect(result).toMatchObject({retry: 1, invalid: 0});
    // 10 minutes doubled for each of the five reads before
    expect(sqs.changeMessageVisibility).toHaveBeenCalledWith(expect.objectContaining({VisibilityTimeout: 19_200}));
    expect(sqs.deleteMessage).not.toHaveBeenCalled();
  });

  it('stops after three messages in a row are asked for again, giving the rest back', async () => {
    vi.spyOn(SecurityService, 'snsTopicOrigin').mockResolvedValue('unknown');
    const batch = Array.from({length: 5}, () => queued({eventType: 'Delivery', mail: {messageId: randomUUID()}}));
    queueHolds(batch);

    const result = await DlqDrainService.drain();

    expect(result.retry).toBe(3);
    expect(sqs.receiveMessage).toHaveBeenCalledOnce();
    const givenBack = sqs.changeMessageVisibility.mock.calls.filter(([input]) => input.VisibilityTimeout === 0);
    expect(givenBack.map(([input]) => input.ReceiptHandle)).toEqual([batch[3]!.ReceiptHandle, batch[4]!.ReceiptHandle]);
  });

  it('handles nothing with Redis down, and gives what it read back', async () => {
    vi.spyOn(redisModule, 'redisReady').mockReturnValue(false);
    const message = queued({eventType: 'Delivery', mail: {messageId: 'dlq-redis-down'}});
    queueHolds([message]);

    const result = await DlqDrainService.drain();

    expect(result).toMatchObject({handled: 0, retry: 0, more: false});
    expect(sqs.changeMessageVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0}),
    );
  });

  it('deletes a message of another account as invalid', async () => {
    queueHolds([queued({eventType: 'Delivery', mail: {messageId: 'dlq-foreign'}}, {topic: FOREIGN_TOPIC})]);

    const result = await DlqDrainService.drain();

    expect(result).toMatchObject({invalid: 1, handled: 0});
    expect(sqs.deleteMessage).toHaveBeenCalledOnce();
    // Of no email: told in every project, without anything of any one
    expect((await failure('aws:dlq-invalid'))?.lastError).toContain('its topic is of another AWS account');
  });

  it("keeps under SQS's 12 hours the wait of a message read many times", async () => {
    await sentEmail('dlq-many-reads');
    vi.spyOn(SecurityService, 'snsTopicOrigin').mockResolvedValue('unknown');
    queueHolds([queued({eventType: 'Bounce', mail: {messageId: 'dlq-many-reads'}}, {receives: 8})]);

    await DlqDrainService.drain();

    expect(sqs.changeMessageVisibility).toHaveBeenCalledWith(expect.objectContaining({VisibilityTimeout: 42_000}));
  });

  describe('a refused signature', () => {
    beforeEach(() => {
      vi.mocked(SnsSignature.verify).mockResolvedValue('invalid');
    });

    it("is read again a few times, in case SNS's certificate was only missing a moment", async () => {
      queueHolds([queued({eventType: 'Bounce', mail: {messageId: 'dlq-sig-once'}}, {receives: 1})]);

      const result = await DlqDrainService.drain();

      expect(result).toMatchObject({retry: 1, invalid: 0});
      expect(sqs.deleteMessage).not.toHaveBeenCalled();
    });

    it('is given up on after four reads', async () => {
      queueHolds([queued({eventType: 'Bounce', mail: {messageId: 'dlq-sig-four'}}, {receives: 4})]);

      const result = await DlqDrainService.drain();

      expect(result).toMatchObject({invalid: 1});
      expect(sqs.deleteMessage).toHaveBeenCalledOnce();
    });

    it('stops the drain after three in a row, giving the rest back undeleted', async () => {
      const batch = Array.from({length: 5}, () =>
        queued({eventType: 'Bounce', mail: {messageId: randomUUID()}}, {receives: 4}),
      );
      queueHolds(batch);

      const result = await DlqDrainService.drain();

      expect(result.invalid).toBe(3);
      const givenBack = sqs.changeMessageVisibility.mock.calls.filter(([input]) => input.VisibilityTimeout === 0);
      expect(givenBack).toHaveLength(2);
    });
  });

  describe('a message that fails every time', () => {
    const POISON_TOPIC = `${OWN_TOPIC}-poison`;
    const poison = () =>
      queued(
        {eventType: 'Bounce', mail: {messageId: 'dlq-poison'}},
        {receives: 8, publishedAt: new Date(Date.now() - 25 * HOUR), topic: POISON_TOPIC},
      );

    beforeEach(() => {
      // Only its own topic fails, as a message of its own would
      vi.spyOn(SecurityService, 'snsTopicOrigin').mockImplementation(async topic =>
        topic === POISON_TOPIC ? 'unknown' : 'own',
      );
    });

    it('is given up on, and said so, when another message goes through in the same drain', async () => {
      await sentEmail('dlq-good');
      const bad = poison();
      queueHolds([bad, queued({eventType: 'Delivery', mail: {messageId: 'dlq-good'}, delivery: {}})]);

      const result = await DlqDrainService.drain();

      expect(result).toMatchObject({handled: 1, invalid: 1});
      expect(sqs.deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ReceiptHandle: bad.ReceiptHandle}));
      expect((await failure('aws:dlq-invalid'))?.lastError).toContain(
        'failed in each of its 8 reads over more than a day',
      );
    });

    it('is kept when nothing else goes through: the failure may be the database or AWS', async () => {
      const bad = poison();
      queueHolds([bad]);

      const result = await DlqDrainService.drain();

      expect(result).toMatchObject({retry: 1, invalid: 0});
      expect(sqs.deleteMessage).not.toHaveBeenCalled();
    });
  });

  it('says nothing in a drain where everything only comes back later', async () => {
    await sentEmail('dlq-only-retry');
    vi.spyOn(SecurityService, 'snsTopicOrigin').mockResolvedValue('unknown');
    queueHolds([queued({eventType: 'Bounce', mail: {messageId: 'dlq-only-retry'}})]);

    await DlqDrainService.drain();

    expect(await failure('aws:dlq')).toBeNull();
  });

  it('tells no project of a message whose project could not be looked up', async () => {
    await sentEmail('dlq-lookup');
    vi.spyOn(appPrisma.email, 'findUnique').mockRejectedValue(new Error('database down'));
    queueHolds([
      queued(
        {eventType: 'Open', mail: {messageId: 'dlq-lookup'}, open: {}},
        {publishedAt: new Date(Date.now() - 25 * HOUR)},
      ),
    ]);

    const result = await DlqDrainService.drain();

    expect(result.old).toBe(1);
    expect(await prisma.plunkLiteFailure.count({where: {projectId, sourceKey: {startsWith: 'aws:dlq'}}})).toBe(0);
  });

  it('leaves the rest to the next drain after 50 batches', async () => {
    await sentEmail('dlq-batches');
    sqs.receiveMessage.mockImplementation(async () => ({
      Messages: [
        queued(
          {eventType: 'Open', mail: {messageId: 'dlq-batches'}, open: {}},
          {publishedAt: new Date(Date.now() - 25 * HOUR)},
        ),
      ],
    }));

    const result = await DlqDrainService.drain();

    expect(sqs.receiveMessage).toHaveBeenCalledTimes(50);
    expect(result).toMatchObject({old: 50, more: true});
  });

  it('leaves the rest to the next drain after 10 minutes', async () => {
    const start = Date.now();
    let calls = 0;
    // The first reading of the clock starts the drain; every later one is 11 minutes on
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? start : start + 11 * 60 * 1000));
    queueHolds([queued({eventType: 'Delivery', mail: {messageId: 'dlq-late'}})]);

    const result = await DlqDrainService.drain();

    expect(result.more).toBe(true);
    expect(sqs.receiveMessage).not.toHaveBeenCalled();
  });

  it('stops when the webhook does not answer in time, giving the rest back', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true});
    try {
      vi.mocked(SnsSignature.verify).mockReturnValue(new Promise(() => undefined));
      const batch = [
        queued({eventType: 'Bounce', mail: {messageId: 'dlq-hang-1'}}),
        queued({eventType: 'Bounce', mail: {messageId: 'dlq-hang-2'}}),
      ];
      queueHolds(batch);

      const drained = DlqDrainService.drain();
      await vi.advanceTimersByTimeAsync(21_000);
      const result = await drained;

      expect(result.retry).toBe(1);
      expect(sqs.changeMessageVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ReceiptHandle: batch[1]!.ReceiptHandle, VisibilityTimeout: 0}),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes after a bounce even a contact who subscribed again since', async () => {
    await sentEmail('dlq-bounce-again');
    const occurredAt = new Date(Date.now() - 3 * HOUR).toISOString();
    await prisma.event.create({
      data: {projectId, contactId, name: 'contact.subscribed', createdAt: new Date(Date.now() - HOUR)},
    });
    queueHolds([
      queued({
        eventType: 'Bounce',
        mail: {messageId: 'dlq-bounce-again', timestamp: occurredAt},
        bounce: {bounceType: 'Permanent', bounceSubType: 'General', timestamp: occurredAt},
      }),
    ]);

    await DlqDrainService.drain();

    expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(false);
  });

  it('keeps subscribed a contact who complained and subscribed again since, suppressing the address', async () => {
    await sentEmail('dlq-complaint');
    const occurredAt = new Date(Date.now() - 3 * HOUR);
    await prisma.event.create({
      data: {projectId, contactId, name: 'contact.subscribed', createdAt: new Date(Date.now() - HOUR)},
    });
    queueHolds([
      queued({
        eventType: 'Complaint',
        mail: {messageId: 'dlq-complaint', timestamp: occurredAt.toISOString()},
        complaint: {timestamp: occurredAt.toISOString()},
      }),
    ]);

    await DlqDrainService.drain();

    const contact = await prisma.contact.findUniqueOrThrow({where: {id: contactId}});
    expect(contact.subscribed).toBe(true);
    expect(await prisma.plunkLiteSuppression.count({where: {projectId, email: contact.email}})).toBe(1);
    expect((await failure('aws:dlq'))?.lastError).toContain('1 contact who complained was left subscribed');
    expect(QueueService.queueEventTracking).toHaveBeenCalledWith(
      expect.objectContaining({data: expect.objectContaining({keptSubscribed: true})}),
      expect.any(String),
    );
  });

  it('does not take the end of a snooze for subscribing again after a complaint', async () => {
    await sentEmail('dlq-complaint-snooze');
    const occurredAt = new Date(Date.now() - 3 * HOUR);
    await prisma.event.create({
      data: {
        projectId,
        contactId,
        name: 'contact.subscribed',
        data: {reason: 'snooze_expired'},
        createdAt: new Date(Date.now() - HOUR),
      },
    });
    queueHolds([
      queued({
        eventType: 'Complaint',
        mail: {messageId: 'dlq-complaint-snooze', timestamp: occurredAt.toISOString()},
        complaint: {timestamp: occurredAt.toISOString()},
      }),
    ]);

    await DlqDrainService.drain();

    expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(false);
  });

  it('stops after two empty reads, and at a stop between messages', async () => {
    queueHolds();
    await DlqDrainService.drain();
    expect(sqs.receiveMessage).toHaveBeenCalledTimes(2);

    sqs.receiveMessage.mockReset();
    queueHolds([queued({eventType: 'Delivery', mail: {messageId: 'dlq-stop'}})]);
    const result = await DlqDrainService.drain(() => true);
    expect(result.more).toBe(true);
    expect(sqs.receiveMessage).not.toHaveBeenCalled();
  });

  describe('check', () => {
    it('closes the alarm notice once the queue is empty', async () => {
      await prisma.plunkLiteFailure.create({
        data: {projectId, sourceKey: DLQ_ALARM_SOURCE, label: 'ses-eventos-dlq', lastError: 'ALARM'},
      });
      sqs.getQueueAttributes.mockResolvedValue({
        Attributes: {ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0'},
      });

      expect(await DlqDrainService.check()).toBe(false);
      const notice = await failure(DLQ_ALARM_SOURCE);
      expect(notice?.reviewedAt).not.toBeNull();
    });

    it('keeps the alarm notice while messages are in flight', async () => {
      await prisma.plunkLiteFailure.create({
        data: {projectId, sourceKey: DLQ_ALARM_SOURCE, label: 'ses-eventos-dlq', lastError: 'ALARM'},
      });
      sqs.getQueueAttributes.mockResolvedValue({
        Attributes: {ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '2'},
      });

      expect(await DlqDrainService.check()).toBe(false);
      expect((await failure(DLQ_ALARM_SOURCE))?.reviewedAt).toBeNull();
    });

    it('says the queue needs draining when it has visible messages', async () => {
      sqs.getQueueAttributes.mockResolvedValue({
        Attributes: {ApproximateNumberOfMessages: '3', ApproximateNumberOfMessagesNotVisible: '0'},
      });
      expect(await DlqDrainService.check()).toBe(true);
    });

    it('shows a missing permission, and only logs a missing queue', async () => {
      sqs.getQueueAttributes.mockRejectedValueOnce(Object.assign(new Error('denied'), {name: 'AccessDenied'}));
      expect(await DlqDrainService.check()).toBe(false);
      expect(await failure('aws:dlq-access:read')).not.toBeNull();

      await prisma.plunkLiteFailure.deleteMany({where: {projectId}});
      sqs.getQueueAttributes.mockRejectedValueOnce(Object.assign(new Error('missing'), {name: 'QueueDoesNotExist'}));
      expect(await DlqDrainService.check()).toBe(false);
      expect(await failure('aws:dlq-access:read')).toBeNull();
    });

    it('keeps a refusal to delete shown although the queue can be counted', async () => {
      await sentEmail('dlq-no-delete');
      sqs.deleteMessage.mockRejectedValue(Object.assign(new Error('denied'), {$metadata: {httpStatusCode: 403}}));
      queueHolds([queued({eventType: 'Delivery', mail: {messageId: 'dlq-no-delete'}, delivery: {}})]);
      sqs.getQueueAttributes.mockResolvedValue({
        Attributes: {ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '1'},
      });

      await DlqDrainService.drain();
      await DlqDrainService.check();

      expect((await failure('aws:dlq-access:drain'))?.reviewedAt).toBeNull();
    });

    it('closes a refusal to drain once the queue can be read again, though it is empty', async () => {
      sqs.receiveMessage.mockRejectedValueOnce(Object.assign(new Error('denied'), {name: 'AccessDenied'}));
      await DlqDrainService.drain();
      expect((await failure('aws:dlq-access:drain'))?.reviewedAt).toBeNull();

      queueHolds();
      await DlqDrainService.drain();
      expect((await failure('aws:dlq-access:drain'))?.reviewedAt).not.toBeNull();
    });

    it('takes an invalid key for what it is, not for a missing permission', async () => {
      sqs.getQueueAttributes.mockRejectedValueOnce(
        Object.assign(new Error('bad key'), {name: 'InvalidClientTokenId', $metadata: {httpStatusCode: 403}}),
      );
      await DlqDrainService.check();
      expect(await failure('aws:dlq-access:read')).toBeNull();
    });
  });
});
