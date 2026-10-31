import {Prisma, StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {QueueService} from '../QueueService';
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

/** Plunk Lite: waiting runs whose wait ended long ago get its job again, or fail when nothing can end it */
describe('WorkflowRecoveryService.recoverWaits', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
    vi.spyOn(QueueService, 'ensureWorkflowWaitEnd').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A WAITING run on a step of `type`, whose latest execution is `step`, last written `writtenAgo` minutes ago */
  async function waitingOn(
    type: WorkflowStepType,
    step: {status: StepExecutionStatus; resumeAt?: Date; executeAfter?: Date},
    writtenAgo = 60,
  ) {
    const workflow = await factories.createWorkflow({projectId});
    const wait = await factories.createWorkflowStep({workflowId: workflow.id, type, config: {}});
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.WAITING, currentStepId: wait.id},
    });
    const stepExecution = await prisma.workflowStepExecution.create({
      data: {
        executionId: execution.id,
        stepId: wait.id,
        status: step.status,
        executeAfter: step.executeAfter,
        output: step.resumeAt ? {resumeAt: step.resumeAt.toISOString()} : undefined,
      },
    });
    await prisma.$executeRaw`UPDATE "workflow_executions" SET "updatedAt" = ${minutesAgo(writtenAgo)} WHERE "id" = ${execution.id}`;
    return {workflow, stepId: wait.id, executionId: execution.id, stepExecutionId: stepExecution.id};
  }

  const runOf = (executionId: string) => prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}});

  it('queues again the end of a delay that ran out over 30 minutes ago, and leaves one that is due later', async () => {
    const lost = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(31),
    });
    await waitingOn(WorkflowStepType.DELAY, {status: StepExecutionStatus.COMPLETED, resumeAt: minutesAgo(29)});
    await waitingOn(WorkflowStepType.DELAY, {status: StepExecutionStatus.COMPLETED, resumeAt: minutesAgo(-600)});

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(1);

    expect(QueueService.ensureWorkflowWaitEnd).toHaveBeenCalledTimes(1);
    expect(QueueService.ensureWorkflowWaitEnd).toHaveBeenCalledWith(
      'delay-end',
      lost.executionId,
      lost.stepId,
      lost.stepExecutionId,
    );
    expect((await runOf(lost.executionId)).status).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('queues again a lost timeout, and leaves a wait without one', async () => {
    const lost = await waitingOn(WorkflowStepType.WAIT_FOR_EVENT, {
      status: StepExecutionStatus.WAITING,
      executeAfter: minutesAgo(31),
    });
    await waitingOn(WorkflowStepType.WAIT_FOR_EVENT, {status: StepExecutionStatus.WAITING}, 60 * 24 * 30);

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(1);

    expect(QueueService.ensureWorkflowWaitEnd).toHaveBeenCalledWith(
      'timeout',
      lost.executionId,
      lost.stepId,
      lost.stepExecutionId,
    );
  });

  it('fails, with an alert, a run waiting on a deleted step, on a wait a week overdue, or on nothing', async () => {
    const deleted = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(-600),
    });
    await prisma.workflowStep.delete({where: {id: deleted.stepId}});
    await prisma.$executeRaw`UPDATE "workflow_executions" SET "updatedAt" = ${minutesAgo(60)} WHERE "id" = ${deleted.executionId}`;
    const stuck = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(8 * 24 * 60),
    });
    // Cut between its two writes by the order from before they were one transaction
    const halfSet = await waitingOn(WorkflowStepType.WAIT_FOR_EVENT, {status: StepExecutionStatus.RUNNING});

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(3);

    expect(await runOf(deleted.executionId)).toMatchObject({
      status: WorkflowExecutionStatus.FAILED,
      exitReason: 'Step deleted',
    });
    expect((await runOf(stuck.executionId)).status).toBe(WorkflowExecutionStatus.FAILED);
    expect((await runOf(halfSet.executionId)).status).toBe(WorkflowExecutionStatus.FAILED);
    const open = await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: halfSet.stepExecutionId}});
    expect(open.status).toBe(StepExecutionStatus.FAILED);
    expect(QueueService.ensureWorkflowWaitEnd).not.toHaveBeenCalled();
    expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(3);
  });

  it('leaves a wait a week overdue whose job is still queued: the worker was stopped, it is late', async () => {
    const late = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(8 * 24 * 60),
    });
    vi.spyOn(QueueService, 'isWorkflowWaitEndPending').mockResolvedValue(true);

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(0);

    expect(QueueService.isWorkflowWaitEndPending).toHaveBeenCalledWith('delay-end', late.stepExecutionId);
    expect((await runOf(late.executionId)).status).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('goes on with the other runs when one cannot be recovered now', async () => {
    const first = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(40),
    });
    const second = await waitingOn(WorkflowStepType.DELAY, {
      status: StepExecutionStatus.COMPLETED,
      resumeAt: minutesAgo(40),
    });
    vi.mocked(QueueService.ensureWorkflowWaitEnd).mockImplementation(async (_type, executionId) => {
      if (executionId === first.executionId) {
        throw new Error('redis down');
      }
      return true;
    });

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(1);

    expect(QueueService.ensureWorkflowWaitEnd).toHaveBeenCalledWith(
      'delay-end',
      second.executionId,
      second.stepId,
      second.stepExecutionId,
    );
  });

  /** A run waiting on a webhook's next attempt, due `dueMinutesAgo` minutes ago (negative: still to come) */
  async function webhookRetry(dueMinutesAgo: number) {
    const workflow = await factories.createWorkflow({projectId, allowReentry: true});
    const step = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://example.com/hook', method: 'POST'},
    });
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.WAITING, currentStepId: step.id},
    });
    const stepExecution = await prisma.workflowStepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        status: StepExecutionStatus.SCHEDULED,
        executeAfter: new Date(Date.now() - dueMinutesAgo * 60_000),
        output: {webhookAttempts: 5},
        error: 'Webhook responded with HTTP 503',
      },
    });
    // Written when it started waiting, which was before it was due
    await prisma.$executeRaw`UPDATE "workflow_executions" SET "updatedAt" = ${new Date(Date.now() - Math.max(dueMinutesAgo + 360, 60) * 60_000)} WHERE "id" = ${execution.id}`;
    return {stepId: step.id, executionId: execution.id, stepExecutionId: stepExecution.id};
  }

  describe('a webhook waiting for its next attempt', () => {
    it('leaves a wait of hours that is not due, instead of failing it as interrupted', async () => {
      const run = await webhookRetry(-120);
      const ensure = vi.spyOn(QueueService, 'ensureWebhookRetry').mockResolvedValue(true);

      expect(await WorkflowRecoveryService.recoverWaits()).toBe(0);

      expect(ensure).not.toHaveBeenCalled();
      expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}})).status).toBe(
        WorkflowExecutionStatus.WAITING,
      );
      ensure.mockRestore();
    });

    it('queues again a lost attempt that was due over 30 minutes ago', async () => {
      const run = await webhookRetry(31);
      const ensure = vi.spyOn(QueueService, 'ensureWebhookRetry').mockResolvedValue(true);

      expect(await WorkflowRecoveryService.recoverWaits()).toBe(1);

      expect(ensure).toHaveBeenCalledWith(run.executionId, run.stepId, run.stepExecutionId, 5);
      ensure.mockRestore();
    });

    it('fails a run and its step a week overdue, unless the job is still queued', async () => {
      const run = await webhookRetry(8 * 24 * 60);
      const pending = vi.spyOn(QueueService, 'isWebhookRetryPending').mockResolvedValue(true);

      expect(await WorkflowRecoveryService.recoverWaits()).toBe(0);

      pending.mockResolvedValue(false);
      expect(await WorkflowRecoveryService.recoverWaits()).toBe(1);

      expect(pending).toHaveBeenCalledWith(run.stepExecutionId, 5);
      expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}})).status).toBe(
        WorkflowExecutionStatus.FAILED,
      );
      expect(await prisma.workflowStepExecution.findUniqueOrThrow({where: {id: run.stepExecutionId}})).toMatchObject({
        status: StepExecutionStatus.FAILED,
        error: 'Webhook responded with HTTP 503',
      });
      pending.mockRestore();
    });
  });

  it('leaves a run that waits half set up for less than 30 minutes', async () => {
    const recent = await waitingOn(WorkflowStepType.WAIT_FOR_EVENT, {status: StepExecutionStatus.RUNNING}, 10);

    expect(await WorkflowRecoveryService.recoverWaits()).toBe(0);

    expect((await runOf(recent.executionId)).status).toBe(WorkflowExecutionStatus.WAITING);
  });
});

describe('WorkflowRecoveryService.sweep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks waits every time, and interrupted runs only after 10 minutes of sweeps without a gap', async () => {
    const waits = vi.spyOn(WorkflowRecoveryService, 'recoverWaits').mockResolvedValue(0);
    const interrupted = vi.spyOn(WorkflowRecoveryService, 'failInterrupted').mockResolvedValue(0);
    const start = Date.now() + 365 * 24 * 60 * 60_000;
    const at = (minutes: number) => start + minutes * 60_000;

    // After a pause (a start, Redis out), BullMQ runs the overdue sweep and the next one a few
    // seconds apart: runs that hung get 10 minutes of sweeps first
    await WorkflowRecoveryService.sweep(at(0));
    await WorkflowRecoveryService.sweep(at(0.05));
    await WorkflowRecoveryService.sweep(at(5));
    expect(interrupted).not.toHaveBeenCalled();

    await WorkflowRecoveryService.sweep(at(10));
    expect(interrupted).toHaveBeenCalledTimes(1);

    // A gap starts the count again
    await WorkflowRecoveryService.sweep(at(30));
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(waits).toHaveBeenCalledTimes(5);
  });

  it('still checks interrupted runs when looking at the waits fails', async () => {
    vi.spyOn(WorkflowRecoveryService, 'recoverWaits').mockRejectedValue(new Error('query failed'));
    const interrupted = vi.spyOn(WorkflowRecoveryService, 'failInterrupted').mockResolvedValue(0);
    const start = Date.now() + 3 * 365 * 24 * 60 * 60_000;

    for (const minutes of [0, 5, 10]) {
      await WorkflowRecoveryService.sweep(start + minutes * 60_000);
    }

    expect(interrupted).toHaveBeenCalledTimes(1);
  });

  it('does not count a sweep that failed (the database out) as one without a gap', async () => {
    const waits = vi.spyOn(WorkflowRecoveryService, 'recoverWaits');
    const interrupted = vi.spyOn(WorkflowRecoveryService, 'failInterrupted').mockResolvedValue(0);
    const start = Date.now() + 2 * 365 * 24 * 60 * 60_000;
    const at = (minutes: number) => start + minutes * 60_000;

    waits.mockResolvedValue(0);
    await WorkflowRecoveryService.sweep(at(0));
    await WorkflowRecoveryService.sweep(at(5));
    waits.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", {code: 'P1001', clientVersion: 'test'}),
    );
    await expect(WorkflowRecoveryService.sweep(at(10))).rejects.toThrow("Can't reach database server");
    await expect(WorkflowRecoveryService.sweep(at(15))).rejects.toThrow("Can't reach database server");

    waits.mockResolvedValue(0);
    await WorkflowRecoveryService.sweep(at(20));
    expect(interrupted).not.toHaveBeenCalled();
  });
});
