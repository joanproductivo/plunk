import {randomUUID} from 'node:crypto';

import type {EventTrackingJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {redis} from '../../database/redis';
import {processEventTracking} from '../../jobs/event-tracking-processor';
import {CampaignService} from '../../services/CampaignService';
import {ContactService} from '../../services/ContactService';
import {EventService} from '../../services/EventService';
import {Keys} from '../../services/keys';
import {eventTrackingQueue, QueueService} from '../../services/QueueService';
import {ReputationCheck} from '../../services/ReputationCheck';
import {getAwsAccountId} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {notification, OWN_TOPIC, post, postSns} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
  sendRawEmail: vi.fn(async () => ({messageId: 'alert-message-id'})),
}));

/**
 * A permanent bounce, one SES could not classify, or a complaint takes the contact off the list,
 * and tracks `contact.unsubscribed` with its `reason` after the email event -- once, and only for
 * a contact who was on the list. A workflow that mirrors unsubscribes to another system listens
 * for that event alone.
 */
describe('Webhooks - the unsubscribe a bounce or complaint causes', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;

    vi.spyOn(SnsSignature, 'verify').mockResolvedValue('valid');
    vi.mocked(getAwsAccountId).mockResolvedValue('111111111111');
    vi.spyOn(ReputationCheck, 'afterEvent').mockResolvedValue();
    // The event is tracked by the worker; here it runs as soon as it is queued
    vi.spyOn(QueueService, 'queueEventTracking').mockImplementation(async data => {
      await processEventTracking({data} as Job<EventTrackingJobData>);
      return {} as Job<EventTrackingJobData>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sentEmail(messageId: string, campaignId?: string, to: string = contactId) {
    return prisma.email.create({
      data: {
        projectId,
        contactId: to,
        campaignId: campaignId ?? null,
        subject: 'Product update',
        body: '<p>news</p>',
        from: 'hello@plunk.test',
        sourceType: campaignId ? 'CAMPAIGN' : 'TRANSACTIONAL',
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId,
      },
    });
  }

  const unsubscribes = () =>
    prisma.event.findMany({where: {projectId, contactId, name: 'contact.unsubscribed'}, orderBy: {createdAt: 'asc'}});

  describe('of an email', () => {
    it.each([
      ['a permanent bounce', 'Bounce', {bounce: {bounceType: 'Permanent'}}, 'email.bounce', 'bounce'],
      ['a bounce SES could not classify', 'Bounce', {bounce: {bounceType: 'Undetermined'}}, 'email.bounce', 'bounce'],
      ['a complaint', 'Complaint', {complaint: {}}, 'email.complaint', 'complaint'],
    ])('tracks contact.unsubscribed after %s', async (_case, eventType, extra, emailEvent, reason) => {
      const email = await sentEmail(`ses-unsub-${randomUUID()}`);
      const track = vi.spyOn(EventService, 'trackEvent');

      await post(notification(eventType, email.messageId!, extra));

      expect(track.mock.calls.map(call => call[1])).toEqual([emailEvent, 'contact.unsubscribed']);
      const [unsubscribe] = await unsubscribes();
      expect(unsubscribe).toMatchObject({emailId: email.id, data: {reason}});
      const tracked = await prisma.event.findFirstOrThrow({where: {emailId: email.id, name: emailEvent}});
      expect(tracked.createdAt.getTime()).toBeLessThanOrEqual(unsubscribe!.createdAt.getTime());
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(false);
    });

    it('tracks it once for copies of the same notification, whatever their SNS message', async () => {
      const email = await sentEmail('ses-unsub-copies');
      const bounce = notification('Bounce', 'ses-unsub-copies', {bounce: {bounceType: 'Permanent'}});
      const send = (messageId: string) =>
        postSns({Type: 'Notification', TopicArn: OWN_TOPIC, MessageId: messageId, Message: JSON.stringify(bounce)});
      const messageId = `sns-message-${randomUUID()}`;

      await Promise.all([send(messageId), send(messageId), send(`sns-message-${randomUUID()}`)]);
      await post(bounce);

      expect(await unsubscribes()).toHaveLength(1);
      expect(await prisma.event.count({where: {emailId: email.id, name: 'email.bounce'}})).toBe(1);
    });

    it('tracks it once when two emails of the contact bounce at the same time', async () => {
      await sentEmail('ses-unsub-first');
      await sentEmail('ses-unsub-second');
      const permanent = {bounce: {bounceType: 'Permanent'}};

      await Promise.all([
        post(notification('Bounce', 'ses-unsub-first', permanent)),
        post(notification('Bounce', 'ses-unsub-second', permanent)),
      ]);

      expect(await unsubscribes()).toHaveLength(1);
      expect(await prisma.event.count({where: {projectId, name: 'email.bounce'}})).toBe(2);
    });

    it('does not tell a contact who was already unsubscribed again', async () => {
      const email = await sentEmail('ses-unsub-already');
      await prisma.contact.update({where: {id: contactId}, data: {subscribed: false}});

      await post(notification('Bounce', 'ses-unsub-already', {bounce: {bounceType: 'Permanent'}}));

      expect(await prisma.event.count({where: {emailId: email.id, name: 'email.bounce'}})).toBe(1);
      expect(await unsubscribes()).toEqual([]);
    });

    it('tells a snoozed contact, whose snooze the bounce ends for good', async () => {
      const email = await sentEmail('ses-unsub-snoozed');
      await ContactService.snooze(contactId, '2_weeks');

      await post(notification('Bounce', 'ses-unsub-snoozed', {bounce: {bounceType: 'Permanent'}}));

      const events = await unsubscribes();
      expect(events.map(event => (event.data as {reason?: string}).reason)).toEqual(['snooze', 'bounce']);
      expect(events[1]?.emailId).toBe(email.id);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).snoozedUntil).toBeNull();
    });

    it('tracks nothing for a transient bounce', async () => {
      await sentEmail('ses-unsub-transient');

      await post(notification('Bounce', 'ses-unsub-transient', {bounce: {bounceType: 'Transient'}}));

      expect(await unsubscribes()).toEqual([]);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(true);
    });

    it('tracks nothing when a workflow email to a custom recipient bounces', async () => {
      const email = await sentEmail('ses-unsub-override');
      await prisma.email.update({
        where: {id: email.id},
        data: {headers: {'X-Plunk-Recipient-Override': 'someone@else.test'}},
      });

      await post(
        notification('Bounce', 'ses-unsub-override', {
          bounce: {bounceType: 'Permanent', bouncedRecipients: [{emailAddress: 'someone@else.test'}]},
        }),
      );

      expect(await unsubscribes()).toEqual([]);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(true);
    });

    it('tracks it once for a bounce of an address already on the suppression list', async () => {
      const email = await sentEmail('ses-unsub-listed');
      const bounce = notification('Bounce', 'ses-unsub-listed', {
        bounce: {bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList'},
      });

      await post(bounce);
      await post(bounce);

      expect(await unsubscribes()).toMatchObject([{emailId: email.id, data: {reason: 'bounce'}}]);
    });

    it('tracks it once for a row whose send is not recorded, whatever copies arrive', async () => {
      // Failed as possibly sent: the row keeps its status, so the copies are told apart by their SNS
      // message, and one without a message id only by the contact being off the list already
      const email = await sentEmail('ses-unsub-unrecorded');
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.FAILED, sentAt: null}});
      const bounce = notification('Bounce', 'ses-unsub-unrecorded', {
        bounce: {bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList'},
      });
      const send = (messageId: string) =>
        postSns({Type: 'Notification', TopicArn: OWN_TOPIC, MessageId: messageId, Message: JSON.stringify(bounce)});
      const messageId = `sns-message-${randomUUID()}`;

      await send(messageId);
      await send(messageId);
      await post(bounce);

      expect(await unsubscribes()).toMatchObject([{emailId: email.id, data: {reason: 'bounce'}}]);
      expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).status).toBe(EmailStatus.FAILED);
    });

    it('starts a workflow listening for contact.unsubscribed once, with the reason', async () => {
      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        // As the workflow that mirrors unsubscribes is set up, so a second run would not be held back
        allowReentry: true,
        triggerConfig: {eventName: 'contact.unsubscribed'},
      });
      await sentEmail('ses-unsub-workflow');
      const bounce = notification('Bounce', 'ses-unsub-workflow', {bounce: {bounceType: 'Permanent'}});

      await post(bounce);
      await post(bounce);

      const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(executions).toHaveLength(1);
      expect(JSON.stringify(executions[0]?.context)).toContain('"reason":"bounce"');
    });
  });

  /**
   * The unsubscribe counts against the campaign as an opt-out, as well as a bounce or complaint,
   * and the recipients it lost count each recipient once
   */
  describe('in the campaign stats', () => {
    let campaignId: string;

    beforeEach(async () => {
      campaignId = (await factories.createCampaign({projectId, name: 'Product update'})).id;
      // One Redis key holds the dirty set for the whole worker
      await redis.del(Keys.Campaign.statsDirty());
    });

    const stats = async () => {
      await CampaignService.sweepDirtyStats(10);
      return CampaignService.getStats(projectId, campaignId);
    };

    it('counts the bounce as an unsubscribe of the campaign too, once, and the recipient lost once', async () => {
      const email = await sentEmail('ses-unsub-campaign', campaignId);
      const bounce = notification('Bounce', 'ses-unsub-campaign', {bounce: {bounceType: 'Permanent'}});

      await post(bounce);
      await post(bounce);

      expect(await stats()).toMatchObject({bouncedCount: 1, unsubscribedCount: 1, lostCount: 1});
      expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).unsubscribedAt).not.toBeNull();
      const listed = await CampaignService.listRecipients(projectId, campaignId, 'unsubscribed');
      expect(listed.total).toBe(1);
    });

    it('does not count a contact who was already unsubscribed', async () => {
      await sentEmail('ses-unsub-campaign-already', campaignId);
      await prisma.contact.update({where: {id: contactId}, data: {subscribed: false}});

      await post(notification('Complaint', 'ses-unsub-campaign-already', {complaint: {}}));

      expect(await stats()).toMatchObject({complainedCount: 1, unsubscribedCount: 0, lostCount: 1});
    });

    it('counts once a recipient who unsubscribed from the page and then reported the email as spam', async () => {
      const email = await sentEmail('ses-unsub-campaign-page', campaignId);
      await ContactService.unsubscribe(contactId, {emailId: email.id});

      await post(notification('Complaint', 'ses-unsub-campaign-page', {complaint: {}}));

      expect(await stats()).toMatchObject({complainedCount: 1, unsubscribedCount: 1, lostCount: 1});
    });

    it('never reports fewer recipients lost than unsubscribed while the bounce counters trail', async () => {
      await sentEmail('ses-unsub-campaign-trailing', campaignId);

      await post(notification('Bounce', 'ses-unsub-campaign-trailing', {bounce: {bounceType: 'Permanent'}}));

      // Read before the sweep recounts the bounces
      expect(await CampaignService.getStats(projectId, campaignId)).toMatchObject({
        bouncedCount: 0,
        unsubscribedCount: 1,
        lostCount: 1,
      });
    });

    it('does not take off more than the bounces counted so far while the sweep is half done', async () => {
      const other = await factories.createContact({projectId, subscribed: true});
      await sentEmail('ses-unsub-campaign-swept', campaignId);
      await sentEmail('ses-unsub-campaign-unswept', campaignId, other.id);
      const permanent = {bounce: {bounceType: 'Permanent'}};

      await post(notification('Bounce', 'ses-unsub-campaign-swept', permanent));
      await CampaignService.sweepDirtyStats(10);
      await post(notification('Bounce', 'ses-unsub-campaign-unswept', permanent));

      // Both emails carry a bounce and an unsubscribe, but the counters hold one bounce so far
      expect(await CampaignService.getStats(projectId, campaignId)).toMatchObject({
        bouncedCount: 1,
        unsubscribedCount: 2,
        lostCount: 2,
      });
    });

    it('counts every unsubscribe of a burst of bounces of the campaign', async () => {
      const recipients = await Promise.all(
        Array.from({length: 6}, async (_, index) => {
          const contact = await factories.createContact({projectId, subscribed: true});
          await sentEmail(`ses-unsub-burst-${index}`, campaignId, contact.id);
          return `ses-unsub-burst-${index}`;
        }),
      );

      await Promise.all(
        recipients.map(messageId => post(notification('Bounce', messageId, {bounce: {bounceType: 'Permanent'}}))),
      );

      expect(await stats()).toMatchObject({bouncedCount: 6, unsubscribedCount: 6, lostCount: 6});
    });

    it('adds the recipients lost to different causes', async () => {
      await sentEmail('ses-unsub-campaign-a', campaignId);
      const other = await factories.createContact({projectId, subscribed: true});
      const optedOut = await sentEmail('ses-unsub-campaign-b', campaignId, other.id);

      await post(notification('Bounce', 'ses-unsub-campaign-a', {bounce: {bounceType: 'Permanent'}}));
      await ContactService.unsubscribe(other.id, {emailId: optedOut.id});

      expect(await stats()).toMatchObject({bouncedCount: 1, unsubscribedCount: 2, lostCount: 2});
    });
  });

  describe('of no stored email', () => {
    beforeEach(async () => {
      await factories.createDomain({projectId, domain: 'plunk.test'});
    });

    // A complaint about an email whose row is gone, tagged with the project that sent it
    const orphanComplaint = (destination: string) => ({
      eventType: 'Complaint',
      mail: {
        messageId: `ses-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        source: 'hello@plunk.test',
        destination: [destination],
        tags: {plunk_email_id: [randomUUID()], plunk_project_id: [projectId]},
      },
      complaint: {},
    });

    it('tracks contact.unsubscribed, without an email, for the contact it takes off the list', async () => {
      const contact = await prisma.contact.findUniqueOrThrow({where: {id: contactId}});
      const complaint = orphanComplaint(contact.email);

      await post(complaint);
      await post(complaint);

      const events = await unsubscribes();
      expect(events).toMatchObject([{emailId: null, data: {reason: 'complaint'}}]);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(false);
    });

    it('does not tell a contact who was already unsubscribed again', async () => {
      const contact = await prisma.contact.update({where: {id: contactId}, data: {subscribed: false}});

      await post(orphanComplaint(contact.email));

      expect(await unsubscribes()).toEqual([]);
    });
  });

  describe('in the worker', () => {
    beforeEach(async () => {
      vi.mocked(QueueService.queueEventTracking).mockRestore();
      await eventTrackingQueue.obliterate({force: true});
    });

    it('queues one job, named after the SNS message, that carries the unsubscribe after the bounce', async () => {
      const email = await sentEmail('ses-unsub-queued');
      const messageId = `sns-message-${randomUUID()}`;

      await postSns({
        Type: 'Notification',
        TopicArn: OWN_TOPIC,
        MessageId: messageId,
        Message: JSON.stringify(notification('Bounce', 'ses-unsub-queued', {bounce: {bounceType: 'Permanent'}})),
      });

      const jobs = await eventTrackingQueue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(`sns-${messageId}`);
      expect(jobs[0]?.data).toMatchObject({
        eventName: 'email.bounce',
        emailId: email.id,
        followUp: {eventName: 'contact.unsubscribed', data: {reason: 'bounce'}},
      });

      await processEventTracking(jobs[0]!);

      expect(await prisma.event.count({where: {emailId: email.id, name: 'email.bounce'}})).toBe(1);
      expect(await unsubscribes()).toHaveLength(1);
    });

    it('tracks the unsubscribe even when tracking the bounce fails, and fails the job', async () => {
      const email = await sentEmail('ses-unsub-failing');
      const failure = new Error('database went away');
      vi.spyOn(EventService, 'trackEvent').mockRejectedValueOnce(failure);

      await expect(
        processEventTracking({
          id: 'sns-failing',
          data: {
            projectId,
            eventName: 'email.bounce',
            contactId,
            emailId: email.id,
            data: {},
            followUp: {eventName: 'contact.unsubscribed', data: {reason: 'bounce'}},
          },
        } as Job<EventTrackingJobData>),
      ).rejects.toBe(failure);

      expect(await unsubscribes()).toMatchObject([{emailId: email.id, data: {reason: 'bounce'}}]);
    });

    it('tracks the unsubscribe without its email when the email is gone by then', async () => {
      const email = await sentEmail('ses-unsub-gone');
      await prisma.email.delete({where: {id: email.id}});

      await expect(
        processEventTracking({
          id: 'sns-gone',
          data: {
            projectId,
            eventName: 'email.bounce',
            contactId,
            emailId: email.id,
            data: {},
            followUp: {eventName: 'contact.unsubscribed', data: {reason: 'bounce'}},
          },
        } as Job<EventTrackingJobData>),
      ).rejects.toThrow();

      // The bounce of an email that is gone cannot be tracked; the unsubscribe can, and is
      expect(await unsubscribes()).toMatchObject([{emailId: null, data: {reason: 'bounce'}}]);
    });

    it('does not track the unsubscribe twice when it fails for another reason', async () => {
      const email = await sentEmail('ses-unsub-other-failure');
      const failure = new Error('workflow went wrong');
      const track = vi.spyOn(EventService, 'trackEvent');
      track.mockResolvedValueOnce({} as never).mockRejectedValueOnce(failure);

      await expect(
        processEventTracking({
          id: 'sns-other-failure',
          data: {
            projectId,
            eventName: 'email.bounce',
            contactId,
            emailId: email.id,
            data: {},
            followUp: {eventName: 'contact.unsubscribed', data: {reason: 'bounce'}},
          },
        } as Job<EventTrackingJobData>),
      ).rejects.toBe(failure);

      expect(track).toHaveBeenCalledTimes(2);
    });
  });
});
