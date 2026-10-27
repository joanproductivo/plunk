import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {WorkflowEntryService} from '../WorkflowEntryService';
import {WorkflowRecoveryService} from '../WorkflowRecoveryService';

/** Plunk Lite: runs a restart left RUNNING are failed, with an alert, so their contacts can enter again */
describe('WorkflowRecoveryService.failInterrupted', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  /** A run in `status`, with a step RUNNING, last written `minutesAgo` minutes ago */
  async function runWrittenAgo(minutesAgo: number, status: WorkflowExecutionStatus = WorkflowExecutionStatus.RUNNING) {
    const workflow = await factories.createWorkflow({projectId, allowReentry: true});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status, currentStepId: trigger.id},
    });
    await prisma.workflowStepExecution.create({
      data: {executionId: execution.id, stepId: trigger.id, status: StepExecutionStatus.RUNNING, startedAt: new Date()},
    });
    // Raw, so Prisma does not stamp updatedAt with now
    await prisma.$executeRaw`UPDATE "workflow_executions" SET "updatedAt" = ${new Date(Date.now() - minutesAgo * 60_000)} WHERE "id" = ${execution.id}`;
    return {workflow, trigger, executionId: execution.id};
  }

  const statusOf = async (executionId: string) =>
    (await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status;

  it('fails a run that has been RUNNING without a write for over 30 minutes, with its step and an alert', async () => {
    const run = await runWrittenAgo(31);

    expect(await WorkflowRecoveryService.failInterrupted()).toBe(1);

    expect(await statusOf(run.executionId)).toBe(WorkflowExecutionStatus.FAILED);
    const step = await prisma.workflowStepExecution.findFirstOrThrow({where: {executionId: run.executionId}});
    expect(step).toMatchObject({status: StepExecutionStatus.FAILED, error: 'Interrupted'});
    const alert = await prisma.plunkLiteFailure.findFirst({
      where: {projectId, sourceKey: `workflow:${run.workflow.id}`},
    });
    expect(alert).not.toBeNull();
  });

  it('leaves a run written in the last 30 minutes, and a waiting one however old', async () => {
    const recent = await runWrittenAgo(29);
    const waiting = await runWrittenAgo(120, WorkflowExecutionStatus.WAITING);

    expect(await WorkflowRecoveryService.failInterrupted()).toBe(0);

    expect(await statusOf(recent.executionId)).toBe(WorkflowExecutionStatus.RUNNING);
    expect(await statusOf(waiting.executionId)).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('lets the contact enter the workflow again once its interrupted run is failed', async () => {
    const run = await runWrittenAgo(31);
    const enter = () => WorkflowEntryService.enter(run.workflow, contactId, run.trigger.id, undefined);
    expect((await enter()).entered).toBe(false);

    await WorkflowRecoveryService.failInterrupted();

    expect((await enter()).entered).toBe(true);
  });
});
