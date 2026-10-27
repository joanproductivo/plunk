import {randomUUID} from 'node:crypto';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {CampaignStatus, EmailSourceType, EmailStatus, WorkflowExecutionStatus} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index';
import {redis} from '../../database/redis';
import {CampaignService} from '../CampaignService';
import {ReputationPolicy} from '../ReputationPolicy';
import {SourceBrakeService} from '../SourceBrakeService';
import {WorkflowService} from '../WorkflowService';

/**
 * Plunk Lite: a campaign or workflow whose emails bounce or are reported as spam is stopped on its
 * own, before the project's rates get bad enough to stop everything it sends.
 */
describe('SourceBrakeService', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
    await redis.flushdb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `count` emails given to SES, the first `bounced` bounced and the next `complained` complained */
  async function sent(
    count: number,
    {
      bounced = 0,
      complained = 0,
      campaignId = null,
      workflowExecutionId = null,
      createdAt = new Date(),
    }: {
      bounced?: number;
      complained?: number;
      campaignId?: string | null;
      workflowExecutionId?: string | null;
      createdAt?: Date;
    } = {},
  ) {
    await prisma.email.createMany({
      data: Array.from({length: count}, (_, i) => ({
        projectId,
        contactId,
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'hello@example.com',
        status: EmailStatus.SENT,
        sourceType: campaignId ? EmailSourceType.CAMPAIGN : EmailSourceType.WORKFLOW,
        campaignId,
        workflowExecutionId,
        messageId: randomUUID(),
        sentAt: createdAt,
        createdAt,
        bouncedAt: i < bounced ? createdAt : null,
        complainedAt: i >= bounced && i < bounced + complained ? createdAt : null,
      })),
    });
  }

  describe('campaigns', () => {
    async function sendingCampaign() {
      return factories.createCampaign({projectId, status: CampaignStatus.SENDING, name: 'Promo'});
    }

    it('cancels a campaign with 10 bounces in 120 sent, and tells the project how to send it again', async () => {
      const campaign = await sendingCampaign();
      await sent(120, {bounced: 10, campaignId: campaign.id});

      await SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`]);

      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );
      const alert = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}});
      expect(alert).toMatchObject({sourceKey: `brake:campaign:${campaign.id}`, label: 'Promo'});
      expect(alert.lastError).toBe(
        'Stopped after 10 bounces in 120 emails sent (8.3%). Duplicate the campaign to send it again: it will go to its whole audience.',
      );
    });

    it('cancels a campaign with 3 complaints in 150 sent', async () => {
      const campaign = await sendingCampaign();
      await sent(150, {complained: 3, campaignId: campaign.id});

      await SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`]);

      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );
    });

    it('leaves a campaign with 99 sent alone, however they bounced', async () => {
      const campaign = await sendingCampaign();
      await sent(99, {bounced: 20, campaignId: campaign.id});

      await SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`]);

      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.SENDING);
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
    });

    it('leaves a campaign that is no longer sending, and one of another project', async () => {
      const finished = await factories.createCampaign({projectId, status: CampaignStatus.SENT});
      await sent(120, {bounced: 20, campaignId: finished.id});
      const cancel = vi.spyOn(CampaignService, 'cancel');

      await SourceBrakeService.brake(projectId, [`campaign:${finished.id}`]);
      const {project: other} = await factories.createUserWithProject();
      await SourceBrakeService.brake(other.id, [`campaign:${finished.id}`]);

      expect(cancel).not.toHaveBeenCalled();
    });

    it('says nothing when the campaign was cancelled by someone else while its rates were counted', async () => {
      const campaign = await sendingCampaign();
      await sent(120, {bounced: 20, campaignId: campaign.id});
      const rates = ReputationPolicy.rates.bind(ReputationPolicy);
      vi.spyOn(ReputationPolicy, 'rates').mockImplementation(async filter => {
        await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.CANCELLED}});
        return rates(filter);
      });
      const cancel = vi.spyOn(CampaignService, 'cancel');

      await SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`]);

      expect(cancel).not.toHaveBeenCalled();
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
    });

    it('still says it stopped the campaign when tidying up after it fails', async () => {
      const campaign = await sendingCampaign();
      await sent(120, {bounced: 20, campaignId: campaign.id});
      vi.spyOn(CampaignService, 'cancel').mockRejectedValue(new HttpException(500, 'database down'));

      await expect(SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`])).rejects.toThrow('database down');

      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );
      expect(
        await prisma.plunkLiteFailure.count({where: {projectId, sourceKey: `brake:campaign:${campaign.id}`}}),
      ).toBe(1);
    });
  });

  describe('workflows', () => {
    async function workflowWithRuns() {
      const workflow = await factories.createWorkflow({projectId, enabled: true, name: 'Welcome'});
      const done = await factories.createWorkflowExecution(workflow.id, contactId, {
        status: WorkflowExecutionStatus.COMPLETED,
      });
      const waitingAfterAnEmail = await factories.createWorkflowExecution(workflow.id, contactId, {
        status: WorkflowExecutionStatus.WAITING,
      });
      const notSentYet = await factories.createWorkflowExecution(workflow.id, contactId);
      return {workflow, done, waitingAfterAnEmail, notSentYet};
    }

    it('disables a workflow with 10 bounces in 60 emails of the last day, and cancels its runs that sent nothing', async () => {
      const {workflow, done, waitingAfterAnEmail, notSentYet} = await workflowWithRuns();
      await sent(59, {bounced: 10, workflowExecutionId: done.id});
      await sent(1, {workflowExecutionId: waitingAfterAnEmail.id});

      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);

      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(false);
      const status = async (id: string) => (await prisma.workflowExecution.findUniqueOrThrow({where: {id}})).status;
      expect(await status(notSentYet.id)).toBe(WorkflowExecutionStatus.CANCELLED);
      expect(await status(waitingAfterAnEmail.id)).toBe(WorkflowExecutionStatus.WAITING);
      const alert = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}});
      expect(alert).toMatchObject({sourceKey: `brake:workflow:${workflow.id}`, label: 'Welcome'});
      expect(alert.lastError).toContain('1 of its runs that had not sent an email yet were cancelled');
    });

    it('leaves a run whose email SES took though its send was not marked, as the rates count it', async () => {
      const {workflow, done, notSentYet} = await workflowWithRuns();
      await sent(60, {bounced: 10, workflowExecutionId: done.id});
      const taken = await factories.createEmail({projectId, contactId, sourceType: EmailSourceType.WORKFLOW});
      await prisma.email.update({
        where: {id: taken.id},
        data: {workflowExecutionId: notSentYet.id, status: EmailStatus.FAILED, sentAt: null, messageId: randomUUID()},
      });

      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);

      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(false);
      expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: notSentYet.id}})).status).not.toBe(
        WorkflowExecutionStatus.CANCELLED,
      );
    });

    it('fails the emails its cancelled runs queued, and leaves those of the runs that sent one', async () => {
      const {workflow, done, waitingAfterAnEmail, notSentYet} = await workflowWithRuns();
      await sent(59, {bounced: 10, workflowExecutionId: done.id});
      await sent(1, {workflowExecutionId: waitingAfterAnEmail.id});
      const queued = await factories.createEmail({
        projectId,
        contactId,
        status: EmailStatus.PENDING,
        sourceType: EmailSourceType.WORKFLOW,
      });
      await prisma.email.update({where: {id: queued.id}, data: {workflowExecutionId: notSentYet.id}});
      const next = await factories.createEmail({projectId, contactId, status: EmailStatus.PENDING});
      await prisma.email.update({where: {id: next.id}, data: {workflowExecutionId: waitingAfterAnEmail.id}});

      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);

      expect(await prisma.email.findUniqueOrThrow({where: {id: queued.id}})).toMatchObject({
        status: EmailStatus.FAILED,
        error: 'Workflow disabled for its bounces or complaints',
      });
      expect((await prisma.email.findUniqueOrThrow({where: {id: next.id}})).status).toBe(EmailStatus.PENDING);
      expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: notSentYet.id}})).status).toBe(
        WorkflowExecutionStatus.CANCELLED,
      );
    });

    it('counts from when the workflow was enabled again, so the bounces that stopped it do not stop it again', async () => {
      const {workflow, done} = await workflowWithRuns();
      await sent(60, {bounced: 20, workflowExecutionId: done.id, createdAt: new Date(Date.now() - 60_000)});
      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);
      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(false);

      await WorkflowService.update(projectId, workflow.id, {enabled: true});
      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);
      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(true);

      // New bounces past the rates do stop it
      await sent(60, {bounced: 20, workflowExecutionId: done.id, createdAt: new Date(Date.now() + 1000)});
      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);
      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(false);
    });

    it('only counts the emails of the last day', async () => {
      const {workflow, done} = await workflowWithRuns();
      await sent(60, {bounced: 20, workflowExecutionId: done.id, createdAt: new Date(Date.now() - 2 * 86_400_000)});
      await sent(10, {workflowExecutionId: done.id});

      await SourceBrakeService.brake(projectId, [`workflow:${workflow.id}`]);

      expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(true);
    });

    it('names the workflow of an email by its execution', async () => {
      const {workflow, done} = await workflowWithRuns();

      expect(await SourceBrakeService.sourceOf({campaignId: null, workflowExecutionId: done.id})).toBe(
        `workflow:${workflow.id}`,
      );
      expect(await SourceBrakeService.sourceOf({campaignId: 'c1', workflowExecutionId: null})).toBe('campaign:c1');
      expect(await SourceBrakeService.sourceOf({campaignId: null, workflowExecutionId: null})).toBeUndefined();
    });
  });

  it('judges every source before throwing the first error', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    await sent(120, {bounced: 20, campaignId: campaign.id});
    const workflow = await factories.createWorkflow({projectId, enabled: true});
    const execution = await factories.createWorkflowExecution(workflow.id, contactId);
    await sent(60, {bounced: 20, workflowExecutionId: execution.id});
    vi.spyOn(CampaignService, 'cancel').mockRejectedValue(new Error('database down'));

    await expect(
      SourceBrakeService.brake(projectId, [`campaign:${campaign.id}`, `workflow:${workflow.id}`]),
    ).rejects.toThrow('database down');

    expect((await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).enabled).toBe(false);
  });
});
