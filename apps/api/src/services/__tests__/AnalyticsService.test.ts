import {CampaignStatus, EmailSourceType, EmailStatus, TemplateType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {type AnalyticsQuery, AnalyticsService} from '../AnalyticsService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

// The streams each tracking mode sends with open and click tracking
const ENABLED = [EmailSourceType.TRANSACTIONAL, EmailSourceType.CAMPAIGN, EmailSourceType.WORKFLOW];
const MARKETING_ONLY = [EmailSourceType.CAMPAIGN, EmailSourceType.WORKFLOW];
const DISABLED: EmailSourceType[] = [];

/**
 * Opens and clicks can only be recorded on emails sent with tracking, so their rates are
 * measured against those emails alone. Counting untracked transactional mail in the
 * denominator diluted the rate of every project tracking marketing mail only.
 */
describe('AnalyticsService - open and click rates against tracked emails', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const project = await factories.createProject();
    projectId = project.id;
    const contact = await factories.createContact({projectId});
    contactId = contact.id;
  });

  const send = (sourceType: EmailSourceType, options: {openedAt?: Date; clickedAt?: Date} = {}) =>
    factories.createEmail({projectId, contactId, sourceType, status: EmailStatus.SENT, sentAt: new Date(), ...options});

  const query = (trackedStreams: EmailSourceType[]): AnalyticsQuery => ({
    projectId,
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 1000),
    tz: 'UTC',
    stream: 'ALL',
    trackedStreams,
  });

  it('measures opens against tracked emails only when transactional mail is not tracked', async () => {
    await send(EmailSourceType.TRANSACTIONAL);
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});

    const overview = await AnalyticsService.getOverview(query(MARKETING_ONLY));

    expect(overview.current).toMatchObject({sent: 2, tracked: 1, opened: 1, openRate: 100});
    expect(overview.streams.find(row => row.stream === 'TRANSACTIONAL')).toMatchObject({sent: 1, tracked: 0});
  });

  it('keeps the rates of a project that tracks everything as they were', async () => {
    await send(EmailSourceType.TRANSACTIONAL);
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date(), clickedAt: new Date()});

    const {current} = await AnalyticsService.getOverview(query(ENABLED));

    expect(current.sent).toBe(2);
    expect(current.opened).toBe(1);
    expect(current.openRate).toBe(50);
    expect(current.clickRate).toBe(50);
  });

  it('measures nothing when tracking is disabled', async () => {
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});
    await send(EmailSourceType.TRANSACTIONAL);

    const {current} = await AnalyticsService.getOverview(query(DISABLED));

    expect(current).toMatchObject({sent: 2, tracked: 0, opened: 0, clicked: 0, openRate: 0, clickRate: 0});
  });

  it('leaves out opens of emails the current mode does not track, so no rate passes 100%', async () => {
    // Opened while the project still tracked transactional mail
    await send(EmailSourceType.TRANSACTIONAL, {openedAt: new Date()});
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});

    const {current} = await AnalyticsService.getOverview(query(MARKETING_ONLY));

    expect(current).toMatchObject({tracked: 1, opened: 1, openRate: 100});
  });

  it('leaves emails sent to the SES mailbox simulator out of every count', async () => {
    const simulated = await send(EmailSourceType.CAMPAIGN);
    await prisma.email.update({where: {id: simulated.id}, data: {simulated: true}});
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});

    const {current} = await AnalyticsService.getOverview(query(ENABLED));

    expect(current.sent).toBe(1);
    expect(current.openRate).toBe(100);
  });

  it('carries the tracked count on every point of the timeseries', async () => {
    await send(EmailSourceType.TRANSACTIONAL);
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});

    const series = await AnalyticsService.getTimeseries(query(MARKETING_ONLY));
    const total = (key: 'sent' | 'tracked' | 'opened') => series.current.reduce((sum, point) => sum + point[key], 0);

    expect({sent: total('sent'), tracked: total('tracked'), opened: total('opened')}).toEqual({
      sent: 2,
      tracked: 1,
      opened: 1,
    });
  });

  it('measures mailbox providers against tracked emails', async () => {
    await send(EmailSourceType.TRANSACTIONAL);
    await send(EmailSourceType.CAMPAIGN, {openedAt: new Date()});

    const {providers} = await AnalyticsService.getDeliverability(query(MARKETING_ONLY));

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({sent: 2, tracked: 1, openRate: 100});
  });

  it('counts soft bounces per email, under their own event and as the email.bounce they were before', async () => {
    const [legacy, current, hard] = [
      await send(EmailSourceType.CAMPAIGN),
      await send(EmailSourceType.CAMPAIGN),
      await send(EmailSourceType.CAMPAIGN),
    ];
    const event = (emailId: string, name: string, data: Record<string, unknown>) =>
      prisma.event.create({data: {projectId, contactId, emailId, name, data}});
    await event(legacy.id, 'email.bounce', {bounceType: 'Transient', transientBounce: true});
    await event(current.id, 'email.softbounce', {bounceType: 'Transient', transientBounce: true});
    // SES retries, and reports each attempt
    await event(current.id, 'email.softbounce', {bounceType: 'Transient', transientBounce: true});
    await event(hard.id, 'email.bounce', {bounceType: 'Permanent'});

    const {softBounces} = await AnalyticsService.getDeliverability(query(ENABLED));

    expect(softBounces).toBe(2);
  });

  it('marks campaigns sent as transactional as untracked when only marketing mail is tracked', async () => {
    const started = async (type: TemplateType) => {
      const campaign = await factories.createCampaign({projectId, type});
      return prisma.campaign.update({
        where: {id: campaign.id},
        data: {status: CampaignStatus.SENT, sentAt: new Date(), sentCount: 10, openedCount: 4},
      });
    };
    const transactional = await started(TemplateType.TRANSACTIONAL);
    const marketing = await started(TemplateType.MARKETING);

    const {rows} = await AnalyticsService.getLeaderboard(query(MARKETING_ONLY), 'campaigns');

    expect(rows.find(row => row.id === transactional.id)).toMatchObject({sent: 10, tracked: 0, opened: 0});
    expect(rows.find(row => row.id === marketing.id)).toMatchObject({sent: 10, tracked: 10, openRate: 40});
  });
});

/**
 * Plunk Lite: a bounce or complaint also unsubscribes the contact, and tracks `contact.unsubscribed`
 * with its `reason`. It counts as an unsubscribe wherever unsubscribes are reported on their own,
 * and once where they are added to bounces and complaints.
 */
describe('AnalyticsService - unsubscribes a bounce or complaint caused', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createProject()).id;
  });

  const query = (): AnalyticsQuery => ({
    projectId,
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 1000),
    tz: 'UTC',
    stream: 'ALL',
    trackedStreams: ENABLED,
  });

  /** A sent email to a fresh contact (or the one given), and the events it led to */
  async function sentWith(events: {name: string; data?: Record<string, unknown>}[], contactId?: string) {
    const contact = contactId ? {id: contactId} : await factories.createContact({projectId});
    const email = await factories.createEmail({
      projectId,
      contactId: contact.id,
      sourceType: EmailSourceType.CAMPAIGN,
      status: EmailStatus.SENT,
      sentAt: new Date(),
    });
    for (const {name, data} of events) {
      await prisma.event.create({data: {projectId, contactId: contact.id, emailId: email.id, name, data}});
    }
  }

  beforeEach(async () => {
    // One opted out from the page, one bounced, which unsubscribed them too
    await sentWith([{name: 'contact.unsubscribed'}]);
    await sentWith([
      {name: 'email.bounce', data: {bounceType: 'Permanent'}},
      {name: 'contact.unsubscribed', data: {reason: 'bounce'}},
    ]);
  });

  it('counts both as unsubscribes in the email metrics', async () => {
    const {current} = await AnalyticsService.getOverview(query());
    expect(current.unsubscribed).toBe(2);

    const {current: points} = await AnalyticsService.getTimeseries(query());
    expect(points.reduce((sum, point) => sum + point.unsubscribed, 0)).toBe(2);
  });

  it('shows the audience figures apart, and counts each contact lost once', async () => {
    const {totals} = await AnalyticsService.getAudience(query());

    expect(totals).toMatchObject({unsubscribed: 2, suppressed: 1, lost: 2});
  });

  it('counts a complaint of no stored email, which tracks only the unsubscribe, under both', async () => {
    const contact = await factories.createContact({projectId});
    await prisma.event.create({
      data: {projectId, contactId: contact.id, name: 'contact.unsubscribed', data: {reason: 'complaint'}},
    });

    const {totals} = await AnalyticsService.getAudience(query());

    expect(totals).toMatchObject({unsubscribed: 3, suppressed: 2, lost: 3});
  });

  it('counts a snoozed contact who then bounced once among the unsubscribed', async () => {
    const contact = await factories.createContact({projectId});
    await sentWith(
      [
        {name: 'contact.unsubscribed', data: {reason: 'snooze'}},
        {name: 'email.bounce', data: {bounceType: 'Permanent'}},
        {name: 'contact.unsubscribed', data: {reason: 'bounce'}},
      ],
      contact.id,
    );

    const {totals} = await AnalyticsService.getAudience(query());

    expect(totals).toMatchObject({unsubscribed: 3, suppressed: 2, lost: 3});
  });
});
