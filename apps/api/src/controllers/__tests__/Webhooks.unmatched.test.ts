import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {prisma as appPrisma} from '../../database/prisma';
import {QueueService} from '../../services/QueueService';
import {ReputationCheck} from '../../services/ReputationCheck';
import {getAwsAccountId} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {OWN_TOPIC, post, postSns} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
  sendRawEmail: vi.fn(async () => ({messageId: 'alert-message-id'})),
}));

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

/**
 * Events whose email the webhook cannot find by its messageId: the send was never recorded (the
 * email was failed as possibly sent), the email was deleted with its contact, or it never had a
 * row (a test send, an alert). The tags SES repeats from the send say which email or project it
 * was, and a permanent bounce or complaint still takes the address off the list.
 */
describe('Webhooks - events without a stored messageId', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contact: {id: string; email: string};

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'plunk.test'});
    contact = await factories.createContact({projectId, subscribed: true});
    vi.spyOn(SnsSignature, 'verify').mockResolvedValue('valid');
    vi.mocked(getAwsAccountId).mockResolvedValue('111111111111');
    vi.spyOn(QueueService, 'queueEventTracking').mockResolvedValue({} as never);
    vi.spyOn(ReputationCheck, 'afterEvent').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An email row as the send path leaves it, without a messageId unless given one */
  const emailRow = (data: {status: EmailStatus; sentAt?: Date; messageId?: string}) =>
    prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'TRANSACTIONAL',
        ...data,
      },
    });

  /** An SES event as published for an email Plunk sent, with the tags it was sent with */
  const event = (
    eventType: string,
    options: {
      tags?: Record<string, string>;
      destination?: string;
      timestamp?: string;
      extra?: Record<string, unknown>;
    } = {},
  ) => ({
    eventType,
    mail: {
      messageId: `ses-${Math.random().toString(36).slice(2)}`,
      timestamp: options.timestamp ?? new Date().toISOString(),
      source: 'hello@plunk.test',
      destination: [options.destination ?? contact.email],
      tags: Object.fromEntries(Object.entries(options.tags ?? {}).map(([name, value]) => [name, [value]])),
    },
    ...options.extra,
  });

  const permanent = {bounce: {bounceType: 'Permanent'}};
  const suppressed = () => prisma.plunkLiteSuppression.findMany({where: {projectId}});
  const unmatchedAlerts = () => prisma.plunkLiteFailure.findMany({where: {projectId, sourceKey: 'sns:unmatched'}});
  const subscribed = async () => (await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed;

  describe('found by its tags', () => {
    it('stores the messageId of a row failed as possibly sent, and records the bounce without moving its status', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});
      const bounce = event('Bounce', {
        tags: {plunk_email_id: email.id, plunk_project_id: projectId, plunk_kind: 'email'},
        extra: permanent,
      });

      const captured = await post(bounce);

      expect(captured.status).toBe(200);
      const row = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
      expect(row).toMatchObject({messageId: bounce.mail.messageId, status: EmailStatus.FAILED, sentAt: null});
      expect(row.bouncedAt).not.toBeNull();
      expect(await subscribed()).toBe(false);
      expect((await suppressed()).map(row => row.email)).toEqual([contact.email.toLowerCase()]);
    });

    it('writes the marks of other events on such a row and leaves it FAILED', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});

      await post(event('Delivery', {tags: {plunk_email_id: email.id, plunk_project_id: projectId}}));

      const row = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
      expect(row.status).toBe(EmailStatus.FAILED);
      expect(row.deliveredAt).not.toBeNull();
    });

    it.each([EmailStatus.PENDING, EmailStatus.SENDING])(
      'asks SNS to wait for a %s row, without writing anything',
      async status => {
        const email = await emailRow({status});

        const captured = await post(
          event('Bounce', {tags: {plunk_email_id: email.id, plunk_project_id: projectId}, extra: permanent}),
        );

        expect(captured.status).toBe(503);
        expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
          status,
          messageId: null,
          bouncedAt: null,
        });
        expect(await subscribed()).toBe(true);
      },
    );

    it.each([EmailStatus.PENDING, EmailStatus.SENDING])(
      'records the bounce on a row still %s past the wait, leaving its status and messageId to the send path',
      async status => {
        const email = await emailRow({status});

        const captured = await post(
          event('Bounce', {
            tags: {plunk_email_id: email.id, plunk_project_id: projectId},
            timestamp: HOUR_AGO(),
            extra: permanent,
          }),
        );

        expect(captured.status).toBe(200);
        const row = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
        expect(row).toMatchObject({status, messageId: null});
        expect(row.bouncedAt).not.toBeNull();
        expect(await subscribed()).toBe(false);
        expect(await suppressed()).toHaveLength(1);
        // The email's own, not one of no email
        expect(await unmatchedAlerts()).toEqual([]);
      },
    );

    it('handles a copy of a bounce of an address already on the account list once, on such a row', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});
      const track = vi.mocked(QueueService.queueEventTracking);
      const bounce = event('Bounce', {
        tags: {plunk_email_id: email.id, plunk_project_id: projectId},
        extra: {bounce: {bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList'}},
      });
      const message = {
        Type: 'Notification',
        TopicArn: OWN_TOPIC,
        MessageId: `sns-copy-${email.id}`,
        Message: JSON.stringify(bounce),
      };

      expect((await postSns(message)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(await subscribed()).toBe(false);
      expect(track).toHaveBeenCalledTimes(1);

      // Subscribed again since: the copy must not take them off the list again
      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: true}});
      expect((await postSns(message)).status).toBe(200);

      expect(await subscribed()).toBe(true);
      expect(track).toHaveBeenCalledTimes(1);
      expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
        status: EmailStatus.FAILED,
        bouncedAt: null,
      });
    });

    it('treats a bounce of a row deleted after it was matched as one of no email', async () => {
      const email = await emailRow({status: EmailStatus.SENT, sentAt: new Date(), messageId: 'ses-deleted-row'});
      const transaction = appPrisma.$transaction.bind(appPrisma);
      vi.spyOn(appPrisma, '$transaction').mockImplementationOnce((async (...args: unknown[]) => {
        await prisma.email.delete({where: {id: email.id}});
        return (transaction as (...a: unknown[]) => unknown)(...args);
      }) as never);

      const captured = await post({
        ...event('Bounce', {tags: {plunk_email_id: email.id, plunk_project_id: projectId}, extra: permanent}),
        mail: {
          messageId: 'ses-deleted-row',
          timestamp: new Date().toISOString(),
          source: 'hello@plunk.test',
          destination: [contact.email],
          tags: {plunk_email_id: [email.id], plunk_project_id: [projectId]},
        },
      });

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(false);
      expect(await suppressed()).toHaveLength(1);
      expect(await unmatchedAlerts()).toHaveLength(1);
    });

    it('does not take the row of another project for the tagged one', async () => {
      const {project: other} = await factories.createUserWithProject();
      const email = await emailRow({status: EmailStatus.FAILED});

      await post(event('Bounce', {tags: {plunk_email_id: email.id, plunk_project_id: other.id}, extra: permanent}));

      expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
        messageId: null,
        bouncedAt: null,
      });
      // Nor is the address suppressed in the tagged project, where the sender domain is not
      // verified: only in the project that has it, as for an untagged event
      expect(await prisma.plunkLiteSuppression.count({where: {projectId: other.id}})).toBe(0);
      expect(await suppressed()).toHaveLength(1);
    });

    it('takes the row of a contact who changed address since, and suppresses the address it went to', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});
      const old = contact.email.toLowerCase();
      await prisma.contact.update({where: {id: contact.id}, data: {email: 'moved@example.com'}});

      const captured = await post(
        event('Bounce', {
          tags: {plunk_email_id: email.id, plunk_project_id: projectId},
          destination: old,
          extra: permanent,
        }),
      );

      expect(captured.status).toBe(200);
      expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).bouncedAt).not.toBeNull();
      // The address is no longer the contact's
      expect(await subscribed()).toBe(true);
      expect((await suppressed()).map(row => row.email)).toEqual([old]);
    });

    it('does not take a row sent to a custom recipient other than the one SES names', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});
      await prisma.email.update({
        where: {id: email.id},
        data: {headers: {'X-Plunk-Recipient-Override': 'custom@example.com'}},
      });

      await post(
        event('Bounce', {
          tags: {plunk_email_id: email.id, plunk_project_id: projectId},
          destination: 'someone-else@example.com',
          extra: permanent,
        }),
      );

      expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
        messageId: null,
        bouncedAt: null,
      });
      expect(await subscribed()).toBe(true);
    });

    it('suppresses the address when the row is deleted between finding it and storing its messageId', async () => {
      const email = await emailRow({status: EmailStatus.FAILED});
      const updateMany = appPrisma.email.updateMany.bind(appPrisma.email);
      vi.spyOn(appPrisma.email, 'updateMany').mockImplementationOnce(async args => {
        await prisma.email.delete({where: {id: email.id}});
        return updateMany(args);
      });

      const captured = await post(
        event('Bounce', {tags: {plunk_email_id: email.id, plunk_project_id: projectId}, extra: permanent}),
      );

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(false);
      expect(await suppressed()).toHaveLength(1);
    });
  });

  describe('without an email row', () => {
    it('suppresses at once the address of a tagged email that is gone, and tells the project', async () => {
      const captured = await post(
        event('Complaint', {
          tags: {plunk_email_id: '0b6b7a2e-1c3d-5e4f-8a9b-0c1d2e3f4a5b', plunk_project_id: projectId},
        }),
      );

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(false);
      expect(await suppressed()).toMatchObject([{email: contact.email.toLowerCase(), reason: 'COMPLAINT'}]);
      expect(await unmatchedAlerts()).toHaveLength(1);
    });

    it('suppresses a complaint about a test send without alerting', async () => {
      const captured = await post(
        event('Complaint', {
          destination: 'member@example.com',
          tags: {plunk_project_id: projectId, plunk_kind: 'test'},
        }),
      );

      expect(captured.status).toBe(200);
      expect((await suppressed()).map(row => row.email)).toEqual(['member@example.com']);
      expect(await unmatchedAlerts()).toEqual([]);
    });

    it('waits for an untagged event within the window, then suppresses by the sender domain', async () => {
      const recent = await post(event('Bounce', {extra: permanent}));
      expect(recent.status).toBe(503);
      expect(await suppressed()).toEqual([]);

      const captured = await post(event('Bounce', {timestamp: HOUR_AGO(), extra: permanent}));

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(false);
      expect(await suppressed()).toHaveLength(1);
      expect(await unmatchedAlerts()).toHaveLength(1);
    });

    it('drops an untagged event whose sender domain more than one project has', async () => {
      const {project: other} = await factories.createUserWithProject();
      await factories.createDomain({projectId: other.id, domain: 'plunk.test'});

      const captured = await post(event('Bounce', {timestamp: HOUR_AGO(), extra: permanent}));

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(true);
      expect(await prisma.plunkLiteSuppression.count({where: {projectId: {in: [projectId, other.id]}}})).toBe(0);
      // Lost, so every project hears about it, without the address
      const alerts = await prisma.plunkLiteFailure.findMany({
        where: {sourceKey: 'sns:unmatched', projectId: {in: [projectId, other.id]}},
      });
      expect(alerts.map(alert => alert.projectId).sort()).toEqual([projectId, other.id].sort());
      expect(alerts[0]!.lastError).toContain('hello@plunk.test');
      expect(alerts[0]!.lastError).not.toContain(contact.email.toLowerCase());
      expect(alerts[0]!.lastContactEmail).toBeNull();
    });

    it('does not take the tag of a project the sender domain is not verified in', async () => {
      const {project: other} = await factories.createUserWithProject();

      const captured = await post(
        event('Complaint', {
          tags: {plunk_email_id: '0b6b7a2e-1c3d-5e4f-8a9b-0c1d2e3f4a5b', plunk_project_id: other.id},
        }),
      );

      expect(captured.status).toBe(200);
      // Suppressed in the one project with the domain, as if untagged
      expect(await prisma.plunkLiteSuppression.count({where: {projectId: other.id}})).toBe(0);
      expect(await suppressed()).toHaveLength(1);
      expect(await subscribed()).toBe(false);
    });

    it('does not suppress on a transient bounce', async () => {
      const captured = await post(
        event('Bounce', {
          tags: {plunk_email_id: '0b6b7a2e-1c3d-5e4f-8a9b-0c1d2e3f4a5b', plunk_project_id: projectId},
          extra: {bounce: {bounceType: 'Transient'}},
        }),
      );

      expect(captured.status).toBe(200);
      expect(await subscribed()).toBe(true);
      expect(await suppressed()).toEqual([]);
    });

    it('does not suppress an address of the SES mailbox simulator', async () => {
      const captured = await post(
        event('Bounce', {
          destination: 'bounce@simulator.amazonses.com',
          tags: {plunk_project_id: projectId, plunk_kind: 'test'},
          extra: permanent,
        }),
      );

      expect(captured.status).toBe(200);
      expect(await suppressed()).toEqual([]);
    });
  });
});
