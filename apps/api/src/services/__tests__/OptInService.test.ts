import {EmailStatus, SegmentType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ContactService} from '../ContactService';
import {EmailService} from '../EmailService';
import {EventService} from '../EventService';
import {FailureAlertService} from '../FailureAlertService';
import {OptInService} from '../OptInService';
import {QueueService} from '../QueueService';
import {SuppressionService} from '../SuppressionService';

/**
 * Plunk Lite's double opt-in: a sign-up from the API waits, unsubscribed, until the contact opens
 * the link of its confirmation email and presses the button.
 */
describe('OptInService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
    await factories.createDomain({projectId, domain: 'plunk.test'});
    await prisma.plunkLiteOptInSettings.create({
      data: {projectId, enabled: true, fromEmail: 'hello@plunk.test', fromName: 'Plunk', texts: {}},
    });
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const requestOf = (contactId: string) => prisma.plunkLiteOptInRequest.findUnique({where: {contactId}});
  const subscribedNow = async (id: string) => (await prisma.contact.findUniqueOrThrow({where: {id}})).subscribed;
  const subscribedEvents = (contactId: string) =>
    prisma.event.count({where: {projectId, contactId, name: 'contact.subscribed'}});

  /** The token in the link of the last confirmation email sent to the contact */
  async function tokenOf(contactId: string): Promise<string> {
    const request = await prisma.plunkLiteOptInRequest.findUniqueOrThrow({where: {contactId}});
    const email = await prisma.email.findUniqueOrThrow({where: {id: request.emailId!}});
    return /\/confirm#([\w-]+)/.exec(email.body)![1]!;
  }

  /** Moves a contact's request back in time, as if its last email went out `minutes` ago */
  const sentAgo = (contactId: string, minutes: number) =>
    prisma.plunkLiteOptInRequest.update({
      where: {contactId},
      data: {lastSentAt: new Date(Date.now() - minutes * 60_000)},
    });

  describe('settings', () => {
    it('is off for a project that never saved it', async () => {
      const other = (await factories.createUserWithProject()).project.id;
      expect(await OptInService.settings(other)).toEqual({enabled: false, fromEmail: null, fromName: null, texts: {}});
      expect(await OptInService.isRequired(other)).toBe(false);
    });

    it('needs a sender on a verified domain of the project to turn it on', async () => {
      await expect(OptInService.saveSettings(projectId, {enabled: true})).rejects.toThrow(/address/);
      await expect(OptInService.saveSettings(projectId, {enabled: true, fromEmail: 'a@other.test'})).rejects.toThrow(
        /not registered/,
      );
      await expect(
        OptInService.saveSettings(projectId, {enabled: true, fromEmail: 'a@plunk.test', texts: {en: {subject: 'x'}}}),
      ).rejects.toThrow(/en:/);

      const saved = await OptInService.saveSettings(projectId, {enabled: true, fromEmail: ' News@Plunk.test '});
      expect(saved).toMatchObject({enabled: true, fromEmail: 'news@plunk.test'});

      // Switching it off works while the sender's domain is down
      await prisma.domain.deleteMany({where: {projectId}});
      expect(await OptInService.saveSettings(projectId, {enabled: false, fromEmail: 'news@plunk.test'})).toMatchObject({
        enabled: false,
      });
    });
  });

  describe('request', () => {
    it('sends one email for sign-ups that arrive together, and its link is the one that works', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      const outcomes = await Promise.all(Array.from({length: 5}, () => OptInService.request(contact)));

      expect(outcomes.filter(outcome => outcome === 'sent')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome === 'throttled')).toHaveLength(4);
      expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(1);
      expect((await OptInService.describe(await tokenOf(contact.id))).status).toBe('pending');
    });

    it('sends again after 15 minutes, with a new link that replaces the old one', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      const first = await tokenOf(contact.id);

      expect(await OptInService.request(contact)).toBe('throttled');
      await sentAgo(contact.id, 16);
      expect(await OptInService.request(contact)).toBe('sent');

      expect(await OptInService.describe(first)).toEqual({status: 'invalid'});
      expect((await OptInService.describe(await tokenOf(contact.id))).status).toBe('pending');
    });

    it('sends at most 3 a day, and none for 30 days after 3 without an answer', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      for (let i = 0; i < 3; i++) {
        expect(await OptInService.request(contact)).toBe('sent');
        await sentAgo(contact.id, 16);
      }
      expect(await OptInService.request(contact)).toBe('throttled');

      // A new day, but three unanswered in a row
      await prisma.plunkLiteOptInRequest.update({
        where: {contactId: contact.id},
        data: {windowStart: new Date(Date.now() - 25 * 3600_000)},
      });
      expect(await OptInService.request(contact)).toBe('throttled');

      await sentAgo(contact.id, 31 * 24 * 60);
      expect(await OptInService.request(contact)).toBe('sent');
      expect((await requestOf(contact.id))!.unanswered).toBe(1);
    });

    it('sends nothing for the public key', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      expect(await OptInService.request(contact, {key: 'public'})).toBe('held');
      expect(await requestOf(contact.id)).toBeNull();
    });

    it('frees the claim and alerts when the email cannot be sent, without throwing', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
      await prisma.domain.deleteMany({where: {projectId}});

      expect(await OptInService.request(contact, {segmentIds: ['segment-1']})).toBe('failed');
      // Still waiting, with its segments, and no limit spent
      expect(await requestOf(contact.id)).toMatchObject({lastSentAt: null, sends: 0, segmentIds: ['segment-1']});
      expect(await OptInService.pendingAmong(projectId, [contact.id])).toEqual(new Set([contact.id]));
      expect(record).toHaveBeenCalledWith(projectId, expect.objectContaining({sourceKey: 'optin'}));

      // The next sign-up tries again at once
      await factories.createDomain({projectId, domain: 'plunk.test'});
      expect(await OptInService.request(contact)).toBe('sent');
    });

    it("stops at the project's hourly limit, alerting, and keeps the contact waiting", async () => {
      const record = vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
      await factories.createContacts(projectId, 500, {subscribed: false});
      await prisma.$executeRaw`
        INSERT INTO "plunk_lite_optin_requests" ("contactId", "projectId", "email", "tokenHash", "lastSentAt")
        SELECT "id", "projectId", "email", md5("id"), now() AT TIME ZONE 'UTC' FROM "contacts" WHERE "projectId" = ${projectId}`;
      const contact = await factories.createContact({projectId, subscribed: false});

      expect(await OptInService.request(contact)).toBe('capped');
      expect(record).toHaveBeenCalledWith(projectId, expect.objectContaining({sourceKey: 'optin'}));
      expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(0);
      expect(await OptInService.pendingAmong(projectId, [contact.id])).toEqual(new Set([contact.id]));
    });

    it('removes the requests of deleted contacts', async () => {
      const gone = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(gone);
      await prisma.email.deleteMany({where: {contactId: gone.id}});
      await prisma.contact.delete({where: {id: gone.id}});
      // An hour later, when the clean-up runs again for this project
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);

      await OptInService.request(await factories.createContact({projectId, subscribed: false}));

      expect(await requestOf(gone.id)).toBeNull();
    });
  });

  describe('abuse', () => {
    it('keeps the limits of a contact that unsubscribes and signs up again', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);

      await ContactService.unsubscribe(contact.id);
      expect(await OptInService.request(contact)).toBe('throttled');
      expect(await prisma.email.count({where: {contactId: contact.id}})).toBe(1);
    });

    it('keeps the link of the last email when the next one cannot be sent', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      const first = await tokenOf(contact.id);
      await sentAgo(contact.id, 16);
      const before = await requestOf(contact.id);
      vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
      vi.spyOn(EmailService, 'sendTransactionalEmail').mockRejectedValueOnce(new Error('Billing limit exceeded'));

      expect(await OptInService.request(contact)).toBe('failed');

      expect(await requestOf(contact.id)).toMatchObject({
        tokenHash: before!.tokenHash,
        lastSentAt: before!.lastSentAt,
        sends: before!.sends,
      });
      expect(await OptInService.confirm(first)).toBe('confirmed');
    });

    it('emails no one who unsubscribed through the public page, or who only received an email', async () => {
      const left = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(left);
      await ContactService.unsubscribe(left.id);
      await sentAgo(left.id, 31 * 24 * 60);
      const customer = await factories.createContact({projectId, subscribed: false});
      await factories.createEmail({projectId, contactId: customer.id, status: EmailStatus.DELIVERED});
      const send = vi.spyOn(EmailService, 'sendTransactionalEmail');

      for (const contact of [left, customer]) {
        await expect(ContactService.subscribe(contact.id)).rejects.toMatchObject({
          errorCode: 'CONFIRMATION_NEEDS_EMAIL',
        });
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps the segments of a sign-up that came too soon for another email', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact, {segmentIds: ['promo-a']});

      expect(await OptInService.request(contact, {segmentIds: ['promo-b']})).toBe('throttled');

      expect((await requestOf(contact.id))!.segmentIds.sort()).toEqual(['promo-a', 'promo-b']);
    });

    it('counts the emails of the last day however old their window is', async () => {
      vi.spyOn(FailureAlertService, 'record').mockResolvedValue(true);
      await factories.createContacts(projectId, 1667, {subscribed: false});
      // 3 emails each, the last an hour ago, in windows that started over a day ago
      await prisma.$executeRaw`
        INSERT INTO "plunk_lite_optin_requests" ("contactId", "projectId", "email", "tokenHash", "sends", "windowStart", "lastSentAt")
        SELECT "id", "projectId", "email", md5("id"), 3, now() AT TIME ZONE 'UTC' - interval '30 hours',
               now() AT TIME ZONE 'UTC' - interval '2 hours'
        FROM "contacts" WHERE "projectId" = ${projectId}`;

      expect(await OptInService.request(await factories.createContact({projectId, subscribed: false}))).toBe('capped');
    });

    it('stops counting as waiting once the address changes', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      await prisma.contact.update({where: {id: contact.id}, data: {email: 'other@plunk.test'}});

      expect(await OptInService.pendingAmong(projectId, [contact.id])).toEqual(new Set());
    });

    it('does not let a contact never on the list pause, which would subscribe it when the pause ends', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await expect(ContactService.snooze(contact.id, '2_weeks')).rejects.toThrow(/subscribed contact/);
    });

    it('does not count a suppressed address as waiting', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      const token = await tokenOf(contact.id);
      await SuppressionService.record(prisma, projectId, [contact.email], 'BOUNCE', null);

      expect(await OptInService.pendingAmong(projectId, [contact.id])).toEqual(new Set());
      expect(await OptInService.describe(token)).toEqual({status: 'invalid'});
    });
  });

  describe('confirm', () => {
    it('subscribes the contact and fires contact.subscribed once, from the confirmation email', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      const token = await tokenOf(contact.id);

      const results = await Promise.all([OptInService.confirm(token), OptInService.confirm(token)]);

      expect(results).toEqual(['confirmed', 'confirmed']);
      expect(await subscribedNow(contact.id)).toBe(true);
      expect(await subscribedEvents(contact.id)).toBe(1);
      const event = await prisma.event.findFirstOrThrow({where: {contactId: contact.id, name: 'contact.subscribed'}});
      expect(event.emailId).toBe((await requestOf(contact.id))!.emailId);
      // Without a `reason`, as a sign-up
      expect(event.data).toBeNull();
      expect((await OptInService.describe(token)).status).toBe('confirmed');
    });

    it('still confirms a link sent long ago that nothing replaced', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      await prisma.plunkLiteOptInRequest.update({
        where: {contactId: contact.id},
        data: {createdAt: new Date('2025-01-01'), lastSentAt: new Date('2025-01-01')},
      });

      expect(await OptInService.confirm(await tokenOf(contact.id))).toBe('confirmed');
    });

    it('joins the segments of the sign-up that still take contacts', async () => {
      const segment = (type: SegmentType) =>
        prisma.segment.create({data: {projectId, name: `${type}-${Math.random()}`, type, trackMembership: true}});
      const kept = await segment(SegmentType.STATIC);
      const deleted = await segment(SegmentType.STATIC);
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact, {segmentIds: [kept.id, deleted.id]});
      await prisma.segment.delete({where: {id: deleted.id}});

      const memberships: number[] = [];
      const trackEvent = EventService.trackEvent.bind(EventService);
      vi.spyOn(EventService, 'trackEvent').mockImplementation(async (...args) => {
        // contact.subscribed finds it in its segments already
        memberships.push(await prisma.segmentMembership.count({where: {contactId: contact.id, exitedAt: null}}));
        return trackEvent(...args);
      });

      await OptInService.confirm(await tokenOf(contact.id));

      expect(memberships).toEqual([1]);
      expect(await prisma.segmentMembership.findMany({where: {contactId: contact.id, exitedAt: null}})).toEqual([
        expect.objectContaining({segmentId: kept.id}),
      ]);
      expect(QueueService.queueSegmentMembershipEvents).toHaveBeenCalledTimes(1);
    });

    it('leaves a contact subscribed meanwhile as it is: no event, no segments', async () => {
      const segment = await prisma.segment.create({data: {projectId, name: 'List', type: SegmentType.STATIC}});
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact, {segmentIds: [segment.id]});
      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: true}});

      expect(await OptInService.confirm(await tokenOf(contact.id))).toBe('confirmed');
      expect(await subscribedEvents(contact.id)).toBe(0);
      expect(await prisma.segmentMembership.count({where: {contactId: contact.id}})).toBe(0);
    });

    it.each([
      ['its address changed', (id: string) => prisma.contact.update({where: {id}, data: {email: 'new@plunk.test'}})],
      [
        'its address was suppressed since',
        async (id: string) => {
          const {email} = await prisma.contact.findUniqueOrThrow({where: {id}});
          await SuppressionService.record(prisma, projectId, [email], 'BOUNCE', null);
        },
      ],
      ['it unsubscribed since', (id: string) => ContactService.unsubscribe(id)],
      ['the operator unsubscribed it', (id: string) => ContactService.update(projectId, id, {subscribed: false})],
      ['it was unsubscribed in bulk', (id: string) => ContactService.bulkUnsubscribe(projectId, [id])],
    ])('does not subscribe a contact once %s', async (_, change) => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      const token = await tokenOf(contact.id);

      await change(contact.id);

      expect(await OptInService.confirm(token)).toBe('invalid');
      expect(await subscribedNow(contact.id)).toBe(false);
    });

    it('refuses a link that is not one', async () => {
      expect(await OptInService.confirm('x'.repeat(43))).toBe('invalid');
      expect(await OptInService.confirm('')).toBe('invalid');
    });
  });

  describe('the waiting contacts', () => {
    it('lists them as the contact list pages, apart from the subscribed, the paused and the confirmed', async () => {
      const segment = await prisma.segment.create({data: {projectId, name: 'List', type: SegmentType.STATIC}});
      const waiting = [];
      for (const email of ['ana@plunk.test', 'bea@plunk.test', 'carla@plunk.test']) {
        const contact = await factories.createContact({projectId, email, subscribed: false});
        await OptInService.request(contact);
        waiting.push(contact);
      }
      await prisma.segmentMembership.create({data: {contactId: waiting[1]!.id, segmentId: segment.id}});
      const paused = await factories.createContact({projectId, email: 'paused@plunk.test', subscribed: false});
      await OptInService.request(paused);
      await prisma.contact.update({where: {id: paused.id}, data: {snoozedUntil: new Date(Date.now() + 86_400_000)}});
      const confirmed = await factories.createContact({projectId, email: 'done@plunk.test', subscribed: false});
      await OptInService.request(confirmed);
      await OptInService.confirm(await tokenOf(confirmed.id));
      await factories.createContact({projectId, email: 'plain@plunk.test', subscribed: false});

      const first = await OptInService.listPending(projectId, {limit: 2, sort: 'email', dir: 'asc'});
      expect(first.data.map(c => c.email)).toEqual(['ana@plunk.test', 'bea@plunk.test']);
      expect(first).toMatchObject({total: 3, hasMore: true});
      const next = await OptInService.listPending(projectId, {
        limit: 2,
        sort: 'email',
        dir: 'asc',
        cursor: first.cursor,
      });
      expect(next.data.map(c => c.email)).toEqual(['carla@plunk.test']);
      expect(next.hasMore).toBe(false);

      expect((await OptInService.listPending(projectId, {search: 'B%'})).data).toEqual([]);
      expect((await OptInService.listPending(projectId, {search: 'BEA'})).data.map(c => c.email)).toEqual([
        'bea@plunk.test',
      ]);
      expect((await OptInService.listPending(projectId, {segmentId: segment.id})).data.map(c => c.email)).toEqual([
        'bea@plunk.test',
      ]);

      // The unsubscribed filter still holds them, besides the plain unsubscribed one
      const unsubscribed = await ContactService.list(projectId, 20, undefined, undefined, {status: 'unsubscribed'});
      expect(unsubscribed.total).toBe(4);
    });

    it('pages by creation date, newest first, like the contact list', async () => {
      for (let i = 0; i < 5; i++) {
        const contact = await factories.createContact({projectId, subscribed: false});
        await prisma.contact.update({where: {id: contact.id}, data: {createdAt: new Date(2026, 0, 1 + i)}});
        await OptInService.request(contact);
      }
      const expected = (await ContactService.list(projectId, 20)).data.map(c => c.id);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await OptInService.listPending(projectId, {limit: 2, cursor});
        seen.push(...page.data.map(c => c.id));
        cursor = page.cursor;
      } while (cursor);

      expect(seen).toEqual(expected);
    });
  });

  describe('sign-ups through upsert', () => {
    const upsert = (email: string, subscribed?: boolean, options = {}) =>
      ContactService.upsertWithOptIn(projectId, email, undefined, subscribed, true, options);

    it('leaves a new contact unsubscribed and asks it to confirm, by default or when asked to subscribe', async () => {
      for (const [email, subscribed] of [
        ['a@plunk.test', undefined],
        ['b@plunk.test', true],
      ] as const) {
        const {contact, optIn} = await upsert(email, subscribed);
        expect(contact.subscribed).toBe(false);
        expect(optIn).toBe('sent');
      }
    });

    it('leaves an unsubscribed contact unsubscribed and a paused one paused until they confirm', async () => {
      const unsubscribed = await factories.createContact({projectId, subscribed: false});
      const paused = await factories.createContact({projectId, subscribed: false});
      const until = new Date(Date.now() + 86_400_000);
      await prisma.contact.update({where: {id: paused.id}, data: {snoozedUntil: until}});

      expect((await upsert(unsubscribed.email, true)).contact.subscribed).toBe(false);
      expect((await upsert(paused.email, true)).contact).toMatchObject({subscribed: false, snoozedUntil: until});
      expect(await prisma.email.count({where: {projectId}})).toBe(2);
    });

    it('asks nothing of a subscribed contact, an unsubscribe, or a suppressed address', async () => {
      const subscribed = await factories.createContact({projectId});
      const suppressed = await factories.createContact({projectId, subscribed: false});
      await SuppressionService.record(prisma, projectId, [suppressed.email], 'COMPLAINT', null);

      expect((await upsert(subscribed.email, true)).optIn).toBeUndefined();
      expect((await upsert('new@plunk.test', false)).optIn).toBeUndefined();
      expect((await upsert(suppressed.email, true)).optIn).toBeUndefined();
      expect(await prisma.email.count({where: {projectId}})).toBe(0);
    });

    it('withdraws a sign-up still to confirm when an unsubscribe comes in', async () => {
      const {contact} = await upsert('a@plunk.test', true);
      await upsert('a@plunk.test', false);
      expect((await requestOf(contact.id))!.withdrawnAt).not.toBeNull();
      expect(await OptInService.pendingAmong(projectId, [contact.id])).toEqual(new Set());
    });

    it("subscribes from the dashboard's form", async () => {
      expect((await upsert('a@plunk.test', true, {consent: 'operator'})).contact.subscribed).toBe(true);
    });

    it('subscribes new contacts from an import, and leaves unsubscribed ones so, without emails', async () => {
      const unsubscribed = await factories.createContact({projectId, subscribed: false});

      expect((await upsert('new@plunk.test', true, {consent: 'import'})).contact.subscribed).toBe(true);
      const held = await upsert(unsubscribed.email, true, {consent: 'import'});
      expect(held).toMatchObject({contact: {subscribed: false}, optIn: 'held'});
      expect(await prisma.email.count({where: {projectId}})).toBe(0);
    });

    it('never subscribes an existing contact for an inbound email, opt-in or not', async () => {
      await prisma.plunkLiteOptInSettings.update({where: {projectId}, data: {enabled: false}});
      const unsubscribed = await factories.createContact({projectId, subscribed: false});

      expect((await upsert(unsubscribed.email, true, {consent: 'none'})).contact.subscribed).toBe(false);
      expect((await upsert('new@plunk.test', true, {consent: 'none'})).contact.subscribed).toBe(true);

      await prisma.plunkLiteOptInSettings.update({where: {projectId}, data: {enabled: true}});
      expect((await upsert('other@plunk.test', true, {consent: 'none'})).contact.subscribed).toBe(false);
      expect(await prisma.email.count({where: {projectId}})).toBe(0);
    });

    it('subscribes as always with the opt-in off', async () => {
      await prisma.plunkLiteOptInSettings.update({where: {projectId}, data: {enabled: false}});
      const unsubscribed = await factories.createContact({projectId, subscribed: false});

      expect(await upsert('new@plunk.test')).toMatchObject({contact: {subscribed: true}});
      expect((await upsert(unsubscribed.email, true)).contact.subscribed).toBe(true);
      expect(await prisma.plunkLiteOptInRequest.count()).toBe(0);
    });
  });

  describe('the public subscribe page', () => {
    it('emails no confirmation to a contact that never signed up nor received an email', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});

      await expect(ContactService.subscribe(contact.id)).rejects.toMatchObject({errorCode: 'CONFIRMATION_NEEDS_EMAIL'});
      expect(await prisma.email.count({where: {projectId}})).toBe(0);
    });

    it('asks a contact to confirm, unless it comes from an email that reached it', async () => {
      const contact = await factories.createContact({projectId, subscribed: false});
      await OptInService.request(contact);
      await sentAgo(contact.id, 16);

      expect(await ContactService.subscribe(contact.id)).toMatchObject({subscribed: false, pendingConfirmation: true});
      expect(await subscribedNow(contact.id)).toBe(false);

      const email = await prisma.email.create({
        data: {
          projectId,
          contactId: contact.id,
          subject: 'News',
          body: '<p>news</p>',
          from: 'hello@plunk.test',
          sourceType: 'CAMPAIGN',
          status: 'DELIVERED',
          sentAt: new Date(),
        },
      });
      expect(await ContactService.subscribe(contact.id, {emailId: email.id})).toMatchObject({subscribed: true});
    });
  });

  it("is checked by a workflow's subscribe step, which only asks a contact still waiting to confirm", async () => {
    const workflow = await factories.createWorkflow({projectId, enabled: true, triggerConfig: {eventName: 'signup'}});
    const trigger = await prisma.workflowStep.findFirstOrThrow({where: {workflowId: workflow.id, type: 'TRIGGER'}});
    await prisma.workflowStep.update({where: {id: trigger.id}, data: {config: {eventName: 'signup'}}});
    const step = await prisma.workflowStep.create({
      data: {
        workflowId: workflow.id,
        type: 'UPDATE_CONTACT',
        name: 'subscribe',
        position: {x: 100, y: 0},
        config: {subscriptionAction: 'subscribe'},
      },
    });
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: step.id}});
    const waiting = await factories.createContact({projectId, subscribed: false});
    await OptInService.request(waiting);
    await sentAgo(waiting.id, 16);
    // Received an email, but never asked to sign up: subscribes from its own link, not from here
    const customer = await factories.createContact({projectId, subscribed: false});
    await factories.createEmail({projectId, contactId: customer.id, status: EmailStatus.DELIVERED});
    const send = vi.spyOn(EmailService, 'sendTransactionalEmail');

    await EventService.trackEvent(projectId, 'signup', waiting.id);
    await EventService.trackEvent(projectId, 'signup', customer.id);

    expect(await subscribedNow(waiting.id)).toBe(false);
    expect(await subscribedNow(customer.id)).toBe(false);
    // Only the contact still waiting is asked again: the event may have come with the public key
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].contactId).toBe(waiting.id);
  });
});
