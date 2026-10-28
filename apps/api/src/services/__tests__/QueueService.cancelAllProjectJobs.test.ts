import {CampaignStatus, EmailSourceType, WorkflowExecutionStatus} from '@plunk/db';
import {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {emailQueue, QueueService, scheduledQueue} from '../QueueService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Disabling a project stops everything it had planned, for good: re-enabling it must not resume a
 * workflow or send a scheduled campaign, since the reason it was disabled (usually its bounce rate)
 * would just disable it again. Only removing the queued jobs used to leave executions WAITING forever.
 */
describe('QueueService - cancelAllProjectJobs', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
    otherProjectId = (await factories.createUserWithProject()).project.id;
    await emailQueue.obliterate({force: true});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await emailQueue.obliterate({force: true});
  });

  /** A pending email of `forProjectId`, with its job queued as the API queues it (with a priority) */
  async function queuedEmail(forProjectId: string) {
    const contact = await factories.createContact({projectId: forProjectId});
    const email = await prisma.email.create({
      data: {
        projectId: forProjectId,
        contactId: contact.id,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@example.com',
        sourceType: EmailSourceType.TRANSACTIONAL,
      },
    });
    await QueueService.queueEmail(email.id, EmailSourceType.TRANSACTIONAL);
    return email;
  }

  it("removes the project's queued email jobs, prioritized ones included, and leaves other projects'", async () => {
    const ours = await queuedEmail(projectId);
    const theirs = await queuedEmail(otherProjectId);

    await QueueService.cancelAllProjectJobs(projectId);

    const left = (await emailQueue.getJobs(['waiting', 'prioritized', 'delayed'])).map(job => job.data.emailId);
    expect(left).not.toContain(ours.id);
    expect(left).toContain(theirs.id);
  });

  it('still cancels the executions when a job cannot be removed, as it just started', async () => {
    await queuedEmail(projectId);
    const waiting = await createExecution(projectId, WorkflowExecutionStatus.WAITING);
    vi.spyOn(Job.prototype, 'remove').mockRejectedValue(new Error('Job could not be removed because it is locked'));

    await QueueService.cancelAllProjectJobs(projectId);

    expect((await statusOf(waiting.id)).status).toBe(WorkflowExecutionStatus.CANCELLED);
  });

  async function createExecution(forProjectId: string, status: WorkflowExecutionStatus) {
    const workflow = await factories.createWorkflow({projectId: forProjectId});
    const contact = await factories.createContact({projectId: forProjectId});
    return prisma.workflowExecution.create({data: {workflowId: workflow.id, contactId: contact.id, status}});
  }

  const statusOf = async (executionId: string) =>
    prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}});

  it('cancels every workflow execution still in progress', async () => {
    const waiting = await createExecution(projectId, WorkflowExecutionStatus.WAITING);
    const running = await createExecution(projectId, WorkflowExecutionStatus.RUNNING);

    await QueueService.cancelAllProjectJobs(projectId);

    for (const execution of [waiting, running]) {
      const after = await statusOf(execution.id);
      expect(after.status).toBe(WorkflowExecutionStatus.CANCELLED);
      expect(after.exitReason).toBe('Project disabled');
      expect(after.completedAt).not.toBeNull();
    }
  });

  it('leaves finished executions and other projects alone', async () => {
    const completed = await createExecution(projectId, WorkflowExecutionStatus.COMPLETED);
    const elsewhere = await createExecution(otherProjectId, WorkflowExecutionStatus.WAITING);

    await QueueService.cancelAllProjectJobs(projectId);

    expect((await statusOf(completed.id)).status).toBe(WorkflowExecutionStatus.COMPLETED);
    expect((await statusOf(elsewhere.id)).status).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('cancels scheduled campaigns and removes their jobs', async () => {
    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const scheduled = await factories.createScheduledCampaign(projectId, scheduledFor, {
      status: CampaignStatus.SCHEDULED,
    });
    await QueueService.scheduleCampaign(scheduled.id, scheduledFor);
    const draft = await factories.createCampaign({projectId});
    await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
    const elsewhere = await factories.createScheduledCampaign(otherProjectId, scheduledFor, {
      status: CampaignStatus.SCHEDULED,
    });

    const cancelled: string[][] = [];
    await QueueService.cancelAllProjectJobs(projectId, async ids => void cancelled.push(ids));

    // Only the ones it cancelled
    expect(cancelled).toEqual([[scheduled.id]]);
    const statusOfCampaign = async (id: string) => (await prisma.campaign.findUniqueOrThrow({where: {id}})).status;
    expect(await statusOfCampaign(scheduled.id)).toBe(CampaignStatus.CANCELLED);
    expect(await scheduledQueue.getJob(`scheduled-campaign-${scheduled.id}`)).toBeUndefined();
    expect(await statusOfCampaign(draft.id)).toBe(CampaignStatus.DRAFT);
    expect(await statusOfCampaign(elsewhere.id)).toBe(CampaignStatus.SCHEDULED);
  });
});
