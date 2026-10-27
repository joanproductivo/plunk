import {beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {ContactService} from '../ContactService';
import {ReputationPolicy} from '../ReputationPolicy';
import {factories, getPrismaClient} from '../../../../../test/helpers';

const DAY_MS = 86_400_000;

/**
 * Plunk Lite: deleting contacts deletes their emails, and AWS keeps counting their bounces and
 * complaints, so a project's rates keep counting them too (DeletedEmailCounts). The brakes of one
 * campaign or workflow only count the emails it still has.
 */
describe('DeletedEmailCounts', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** An email as the send path and the webhook leave it; sent unless `unsent` */
  const email = (
    contactId: string,
    options: {
      ago?: number;
      unsent?: boolean;
      bounced?: boolean;
      complained?: boolean;
      simulated?: boolean;
      campaignId?: string;
      workflowExecutionId?: string;
    } = {},
  ) => {
    const createdAt = new Date(Date.now() - (options.ago ?? 0));
    return prisma.email.create({
      data: {
        projectId,
        contactId,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: options.campaignId ? 'CAMPAIGN' : options.workflowExecutionId ? 'WORKFLOW' : 'TRANSACTIONAL',
        campaignId: options.campaignId,
        workflowExecutionId: options.workflowExecutionId,
        status: options.unsent ? EmailStatus.PENDING : EmailStatus.SENT,
        sentAt: options.unsent ? null : createdAt,
        bouncedAt: options.bounced ? createdAt : null,
        complainedAt: options.complained ? createdAt : null,
        simulated: options.simulated ?? false,
        createdAt,
      },
    });
  };

  const projectRates = async () => ({
    day: await ReputationPolicy.rates({projectId, since: new Date(Date.now() - DAY_MS)}),
    week: await ReputationPolicy.rates({projectId, since: new Date(Date.now() - 7 * DAY_MS)}),
    ever: await ReputationPolicy.rates({projectId}),
  });

  it('deleting the contacts that bounced or complained leaves the project rates as they were', async () => {
    const good = await factories.createContact({projectId});
    const bouncedNow = await factories.createContact({projectId});
    const complainedOld = await factories.createContact({projectId});
    const bouncedOld = await factories.createContact({projectId});
    for (let i = 0; i < 3; i++) {
      await email(good.id);
    }
    await email(bouncedNow.id, {bounced: true});
    // Neither counts in any rate, deleted or not
    await email(bouncedNow.id, {unsent: true});
    await email(bouncedNow.id, {bounced: true, simulated: true});
    await email(complainedOld.id, {complained: true, ago: 10 * DAY_MS});
    await email(bouncedOld.id, {bounced: true, ago: 3 * DAY_MS});

    const before = await projectRates();
    expect(before.day).toMatchObject({total: 4, bounces: 1, complaints: 0});
    expect(before.week).toMatchObject({total: 5, bounces: 2, complaints: 0});
    expect(before.ever).toMatchObject({total: 6, bounces: 2, complaints: 1});

    await ContactService.delete(projectId, bouncedNow.id);
    await ContactService.bulkDelete(projectId, [complainedOld.id, bouncedOld.id]);

    expect(await prisma.email.count({where: {contactId: {not: good.id}}})).toBe(0);
    expect(await projectRates()).toEqual(before);
  });

  it('adds the deletes of the same minute together, per project', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-20T10:40:05Z'));
    const other = await factories.createUserWithProject();
    const otherContact = await factories.createContact({projectId: other.project.id});
    await prisma.email.create({
      data: {
        projectId: other.project.id,
        contactId: otherContact.id,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'TRANSACTIONAL',
        status: EmailStatus.SENT,
        sentAt: new Date(),
        bouncedAt: new Date(),
      },
    });
    const first = await factories.createContact({projectId});
    const second = await factories.createContact({projectId});
    await email(first.id, {bounced: true});
    await email(second.id);
    await email(second.id, {complained: true});

    await ContactService.delete(projectId, first.id);
    await ContactService.bulkDelete(projectId, [second.id, otherContact.id]);

    const rows = await prisma.plunkLiteDeletedEmailCount.findMany({where: {projectId}});
    expect(rows).toHaveLength(1);
    // The column is still called hour, and holds the minute
    expect(rows[0]).toMatchObject({hour: new Date('2026-10-20T10:40:00Z'), sent: 3, bounced: 1, complained: 1});
    // The other project's contact was not this project's to delete
    expect(await prisma.contact.count({where: {id: otherContact.id}})).toBe(1);
    expect(await prisma.plunkLiteDeletedEmailCount.count({where: {projectId: other.project.id}})).toBe(0);
    expect(await ReputationPolicy.rates({projectId: other.project.id})).toMatchObject({total: 1, bounces: 1});
  });

  it('counts no deleted email in the brakes of a campaign or a workflow', async () => {
    const campaign = await factories.createCampaign({projectId});
    const workflow = await factories.createWorkflow({projectId});
    const stays = await factories.createContact({projectId});
    const goes = await factories.createContact({projectId});
    const staysExecution = await factories.createWorkflowExecution(workflow.id, stays.id);
    const goesExecution = await factories.createWorkflowExecution(workflow.id, goes.id);
    await email(stays.id, {campaignId: campaign.id});
    await email(goes.id, {campaignId: campaign.id, bounced: true});
    await email(stays.id, {workflowExecutionId: staysExecution.id});
    await email(goes.id, {workflowExecutionId: goesExecution.id, complained: true});

    await ContactService.delete(projectId, goes.id);

    expect(await ReputationPolicy.rates({projectId, campaignId: campaign.id})).toMatchObject({
      total: 1,
      bounces: 0,
      complaints: 0,
    });
    expect(await ReputationPolicy.rates({projectId, workflowId: workflow.id})).toMatchObject({
      total: 1,
      bounces: 0,
      complaints: 0,
    });
    // The project still counts both
    expect(await ReputationPolicy.rates({projectId})).toMatchObject({total: 4, bounces: 1, complaints: 1});
  });

  it('keeps the project from going back under its disable threshold by deleting the contacts that bounced', async () => {
    const contacts = await factories.createContacts(projectId, 40);
    for (const [i, contact] of contacts.entries()) {
      for (let j = 0; j < 5; j++) {
        await email(contact.id, {bounced: i < 30 && j === 0});
      }
    }
    const before = await ReputationPolicy.disableByMetric(projectId);
    expect(before.sevenDay).toMatchObject({total: 200, bounces: 30});
    expect(before.bounce).toBe(true);

    await ContactService.bulkDelete(
      projectId,
      contacts.slice(0, 30).map(c => c.id),
    );

    const after = await ReputationPolicy.disableByMetric(projectId);
    expect(after.sevenDay).toEqual(before.sevenDay);
    expect(after.bounce).toBe(true);
  });

  it('adds up a week of counts kept by the minute at once', async () => {
    // One row a minute for 7 days, each with one bounce in ten emails
    await prisma.$executeRaw`
      INSERT INTO "plunk_lite_deleted_email_counts" ("projectId", "hour", "sent", "bounced", "complained")
      SELECT ${projectId}, date_trunc('minute', now() AT TIME ZONE 'UTC') - make_interval(mins => n), 10, 1, 0
      FROM generate_series(1, 10080) AS n`;

    const started = Date.now();
    const ever = await ReputationPolicy.rates({projectId});
    const elapsed = Date.now() - started;

    expect(ever).toMatchObject({total: 100_800, bounces: 10_080, complaints: 0});
    expect(elapsed).toBeLessThan(2000);
  });
});
