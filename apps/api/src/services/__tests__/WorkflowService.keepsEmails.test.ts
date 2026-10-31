import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';

import {notification, post} from '../../controllers/__tests__/snsWebhook';
import {QueueService} from '../QueueService';
import {ReputationCheck} from '../ReputationCheck';
import {getAwsAccountId} from '../SESService';
import {SnsSignature} from '../SnsSignature';
import {WorkflowService} from '../WorkflowService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  getAwsAccountId: vi.fn(),
}));

/**
 * Plunk Lite: deleting a workflow or its steps keeps the emails they sent, so that a bounce or a
 * complaint SES reports afterwards still finds its email (WorkflowEmailLinks).
 */
describe('WorkflowService - deleting keeps the emails sent', () => {
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
    vi.spyOn(ReputationCheck, 'afterEvent').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A workflow trigger → email → email, and an email sent by `stepIndex`, already completed */
  async function workflowWithSentEmail(stepIndex: 1 | 2 = 1) {
    const {workflow, steps} = await factories.createWorkflowWithSteps(projectId, [
      {type: WorkflowStepType.TRIGGER},
      {type: WorkflowStepType.SEND_EMAIL},
      {type: WorkflowStepType.SEND_EMAIL},
    ]);
    for (let i = 0; i < steps.length - 1; i++) {
      await prisma.workflowTransition.create({data: {fromStepId: steps[i]!.id, toStepId: steps[i + 1]!.id}});
    }
    const execution = await factories.createWorkflowExecution(workflow.id, contactId, {
      status: WorkflowExecutionStatus.COMPLETED,
    });
    const stepExecution = await prisma.workflowStepExecution.create({
      data: {executionId: execution.id, stepId: steps[stepIndex]!.id, status: 'COMPLETED'},
    });
    const messageId = `ses-${Math.random().toString(36).slice(2)}`;
    const email = await prisma.email.create({
      data: {
        projectId,
        contactId,
        subject: 'Welcome',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'WORKFLOW',
        workflowExecutionId: execution.id,
        workflowStepExecutionId: stepExecution.id,
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId,
      },
    });
    return {workflow, steps, execution, email, messageId};
  }

  /** A permanent bounce for the email, after the delete */
  async function bounce(emailId: string, messageId: string) {
    const captured = await post(notification('Bounce', messageId, {bounce: {bounceType: 'Permanent'}}));
    expect(captured.status).toBe(200);
    return prisma.email.findUnique({where: {id: emailId}});
  }

  it('keeps the emails of a deleted workflow, without its execution, and a later bounce finds them', async () => {
    const {workflow, email, messageId} = await workflowWithSentEmail();

    await WorkflowService.delete(projectId, workflow.id);

    expect(await prisma.workflow.count({where: {id: workflow.id}})).toBe(0);
    const kept = await prisma.email.findUnique({where: {id: email.id}});
    expect(kept).toMatchObject({sourceType: 'WORKFLOW', workflowExecutionId: null, workflowStepExecutionId: null});

    const bounced = await bounce(email.id, messageId);
    expect(bounced?.bouncedAt).not.toBeNull();
    expect(bounced?.status).toBe(EmailStatus.BOUNCED);
  });

  it('keeps the emails of workflows deleted in bulk', async () => {
    const first = await workflowWithSentEmail();
    const second = await workflowWithSentEmail();

    const result = await WorkflowService.bulkUpdate(projectId, {
      ids: [first.workflow.id, second.workflow.id],
      delete: true,
    });

    expect(result.deleted).toBe(2);
    const kept = await prisma.email.findMany({where: {id: {in: [first.email.id, second.email.id]}}});
    expect(kept).toHaveLength(2);
    expect(kept.every(e => e.workflowExecutionId === null && e.workflowStepExecutionId === null)).toBe(true);

    expect((await bounce(first.email.id, first.messageId))?.bouncedAt).not.toBeNull();
  });

  it('leaves the emails of other workflows linked', async () => {
    const deleted = await workflowWithSentEmail();
    const other = await workflowWithSentEmail();

    await WorkflowService.delete(projectId, deleted.workflow.id);

    expect(await prisma.email.findUnique({where: {id: other.email.id}})).toMatchObject({
      workflowExecutionId: other.execution.id,
      workflowStepExecutionId: other.email.workflowStepExecutionId,
    });
  });

  it('keeps the email of a deleted step, still linked to its execution', async () => {
    const {workflow, steps, execution, email, messageId} = await workflowWithSentEmail(2);

    await WorkflowService.deleteStep(projectId, workflow.id, steps[2]!.id);

    expect(await prisma.workflowStep.count({where: {id: steps[2]!.id}})).toBe(0);
    const kept = await prisma.email.findUnique({where: {id: email.id}});
    // The execution stays, so the email still counts for the workflow's brake
    expect(kept).toMatchObject({workflowExecutionId: execution.id, workflowStepExecutionId: null});

    expect((await bounce(email.id, messageId))?.bouncedAt).not.toBeNull();
  });

  it('keeps the emails of the steps deleted downstream of a deleted step', async () => {
    const {workflow, steps, execution, email} = await workflowWithSentEmail(2);

    // Deleting the first email step deletes the second one, which sent the email, with it
    await WorkflowService.deleteStep(projectId, workflow.id, steps[1]!.id);

    expect(await prisma.workflowStep.count({where: {id: {in: [steps[1]!.id, steps[2]!.id]}}})).toBe(0);
    expect(await prisma.email.findUnique({where: {id: email.id}})).toMatchObject({
      workflowExecutionId: execution.id,
      workflowStepExecutionId: null,
    });
  });

  it('keeps the email of a step spliced out of the flow', async () => {
    const {workflow, steps, execution, email, messageId} = await workflowWithSentEmail(1);

    await WorkflowService.spliceStep(projectId, workflow.id, steps[1]!.id);

    expect(await prisma.workflowStep.count({where: {id: steps[1]!.id}})).toBe(0);
    expect(await prisma.email.findUnique({where: {id: email.id}})).toMatchObject({
      workflowExecutionId: execution.id,
      workflowStepExecutionId: null,
    });
    expect((await bounce(email.id, messageId))?.bouncedAt).not.toBeNull();
  });
});
