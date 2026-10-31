import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {prisma as appPrisma} from '../../database/prisma';
import {redis} from '../../database/redis';
import {QueueService} from '../../services/QueueService';
import {SNS_REJECTS_KEY} from '../../services/SesEventMatch';
import {getAwsAccountId} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {FOREIGN_TOPIC, notification, OWN_TOPIC, post, postSns} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
  sendRawEmail: vi.fn(async () => ({messageId: 'alert-message-id'})),
}));

/**
 * The SES event pipeline as a whole: notifications the webhook cannot read, deliveries it turns
 * away, and the subscription itself going away. None of these concern one email, so they are
 * reported to the projects rather than lost in the log.
 */
describe('Webhooks - SES event pipeline', () => {
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
    await redis.del(SNS_REJECTS_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Failures are Plunk Lite's own table, which the suite does not empty between tests
  const failures = (sourceKey: string, projectIds = [projectId]) =>
    prisma.plunkLiteFailure.findMany({where: {sourceKey, projectId: {in: projectIds}}});

  describe('reading the notification', () => {
    it('applies an identity notification, which names its type notificationType', async () => {
      const email = await prisma.email.create({
        data: {
          projectId,
          contactId,
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'hello@plunk.test',
          sourceType: 'TRANSACTIONAL',
          status: EmailStatus.SENT,
          sentAt: new Date(),
          messageId: 'ses-identity-bounce',
        },
      });

      const captured = await post({
        notificationType: 'Bounce',
        mail: {messageId: 'ses-identity-bounce', timestamp: new Date().toISOString()},
        bounce: {bounceType: 'Permanent'},
      });

      expect(captured.status).toBe(200);
      expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).status).toBe(EmailStatus.BOUNCED);
    });

    it('acknowledges a message that is not JSON, and tells every active project', async () => {
      const {project: disabled} = await factories.createUserWithProject({}, {disabled: true});

      const captured = await postSns({Type: 'Notification', TopicArn: OWN_TOPIC, Message: '{not json'});

      expect(captured.status).toBe(200);
      const recorded = await failures('sns:invalid', [projectId, disabled.id]);
      expect(recorded.map(failure => failure.projectId)).toEqual([projectId]);
    });

    it('acknowledges the test message SES publishes to a new event destination, telling no one', async () => {
      const captured = await postSns({
        Type: 'Notification',
        TopicArn: OWN_TOPIC,
        Message: 'Successfully validated SNS topic for Amazon SES event publishing.',
      });

      expect(captured.status).toBe(200);
      expect(await failures('sns:invalid')).toEqual([]);
    });

    it('acknowledges a handled type without a message id, and tells the projects', async () => {
      const captured = await post({eventType: 'Bounce', mail: {}, bounce: {bounceType: 'Permanent'}});

      expect(captured.status).toBe(200);
      expect(await failures('sns:invalid')).toHaveLength(1);
    });

    it('acknowledges a type it does not handle without reading the database', async () => {
      const lookup = vi.spyOn(appPrisma.email, 'findUnique');

      const captured = await post({notificationType: 'AmazonSnsSubscriptionSucceeded', message: 'ok'});

      expect(captured.status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
      expect(await failures('sns:invalid')).toEqual([]);
    });

    it('skips an inbound email without a sender instead of failing on it', async () => {
      await factories.createDomain({projectId, domain: 'inbound.test'});

      const captured = await post({
        notificationType: 'Received',
        mail: {messageId: 'ses-inbound-no-source', timestamp: new Date().toISOString(), commonHeaders: {}},
        receipt: {recipients: ['hello@inbound.test']},
      });

      expect(captured.status).toBe(200);
      expect(await prisma.email.count({where: {projectId, status: EmailStatus.RECEIVED}})).toBe(0);
    });
  });

  describe('deliveries turned away', () => {
    it('notes a bad signature without alerting anyone', async () => {
      vi.mocked(SnsSignature.verify).mockResolvedValue('invalid');

      const captured = await post(notification('Delivery', 'ses-forged'));

      expect(captured.status).toBe(403);
      expect(await redis.hget(SNS_REJECTS_KEY, 'signature')).not.toBeNull();
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
    });

    it('notes a topic of another account without alerting anyone', async () => {
      const captured = await post(notification('Delivery', 'ses-foreign'), FOREIGN_TOPIC);

      expect(captured.status).toBe(403);
      expect(await redis.hget(SNS_REJECTS_KEY, 'topic')).not.toBeNull();
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
    });
  });

  it('tells the projects, naming the topic, when the subscription is removed', async () => {
    const captured = await postSns({Type: 'UnsubscribeConfirmation', TopicArn: OWN_TOPIC});

    expect(captured.status).toBe(200);
    const [failure] = await failures('sns:subscription');
    expect(failure).toMatchObject({projectId, label: 'SES events subscription removed'});
    expect(failure?.lastError).toContain(OWN_TOPIC);
  });
});
