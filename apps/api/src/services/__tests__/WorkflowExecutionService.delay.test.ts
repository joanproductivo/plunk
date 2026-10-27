import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {QueueService} from '../QueueService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {WorkflowService} from '../WorkflowService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../QueueService', () => ({
  QueueService: {
    // Runs the queueing it is given, which here is a mock too
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueWorkflowDelayEnd: vi.fn(async () => ({id: 'mock-delay-end-job-id'})),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
  },
}));

const DELAY = {type: WorkflowStepType.DELAY, config: {amount: 1, unit: 'hours'}};

let projectId: string;
let contactId: string;
const prisma = getPrismaClient();

/** TRIGGER → DELAY, with nothing after the delay and a RUNNING execution. */
async function createRun() {
  const workflow = await factories.createWorkflow({projectId});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  const delay = await factories.createWorkflowStep({workflowId: workflow.id, type: DELAY.type, config: DELAY.config});
  await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: delay.id}});

  const execution = await prisma.workflowExecution.create({
    data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
  });

  return {
    workflowId: workflow.id,
    executionId: execution.id,
    delayStepId: delay.id,
    start: () => WorkflowExecutionService.processStepExecution(execution.id, trigger.id),
    endDelay: () => WorkflowExecutionService.processDelayEnd(execution.id, delay.id),
  };
}

type Run = Awaited<ReturnType<typeof createRun>>;

/** Where the run ended up, and how many emails it sent. */
async function outcome(run: Run) {
  const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
  const emails = await prisma.email.count({where: {workflowExecutionId: run.executionId}});
  return {status, emails};
}

/**
 * A delay that is the last step used to queue nothing, leaving the execution WAITING forever.
 * It now schedules its own end, which completes the run (or follows a step connected in the meantime).
 */
describe('WorkflowExecutionService - a delay with no step after it', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('schedules the end of the delay', async () => {
    const run = await createRun();

    await run.start();

    expect(await outcome(run)).toEqual({status: WorkflowExecutionStatus.WAITING, emails: 0});
    expect(QueueService.queueWorkflowDelayEnd).toHaveBeenCalledWith(
      run.executionId,
      run.delayStepId,
      expect.any(String),
      60 * 60 * 1000,
    );
  });

  it('completes the run when the delay ends', async () => {
    const run = await createRun();
    await run.start();

    await run.endDelay();

    expect(await outcome(run)).toEqual({status: WorkflowExecutionStatus.COMPLETED, emails: 0});
    const execution = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(execution.currentStepId).toBeNull();
    expect(execution.completedAt).not.toBeNull();
  });

  it('runs a step connected after the delay while the contact was waiting', async () => {
    const run = await createRun();
    await run.start();

    const template = await factories.createTemplate({projectId});
    const send = await factories.createWorkflowStep({
      workflowId: run.workflowId,
      type: WorkflowStepType.SEND_EMAIL,
      templateId: template.id,
    });
    await prisma.workflowTransition.create({data: {fromStepId: run.delayStepId, toStepId: send.id}});

    await run.endDelay();

    expect(await outcome(run)).toEqual({status: WorkflowExecutionStatus.COMPLETED, emails: 1});
  });

  it('leaves a cancelled run cancelled when the delay ends', async () => {
    const run = await createRun();
    await run.start();
    await WorkflowService.cancelExecution(projectId, run.workflowId, run.executionId);

    await run.endDelay();

    expect(await outcome(run)).toEqual({status: WorkflowExecutionStatus.CANCELLED, emails: 0});
  });

  it('does nothing when the run no longer exists', async () => {
    const run = await createRun();
    await run.start();
    await prisma.workflowExecution.delete({where: {id: run.executionId}});

    await expect(run.endDelay()).resolves.toBeUndefined();
  });
});

/** TRIGGER → DELAY → … → SEND_EMAIL, with the given steps between the delay and the email. */
async function createRoute(between: number) {
  const workflow = await factories.createWorkflow({projectId});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  const delays = [];
  let from = trigger.id;
  for (let i = 0; i <= between; i++) {
    const delay = await factories.createWorkflowStep({workflowId: workflow.id, type: DELAY.type, config: DELAY.config});
    await prisma.workflowTransition.create({data: {fromStepId: from, toStepId: delay.id}});
    delays.push(delay.id);
    from = delay.id;
  }
  const template = await factories.createTemplate({projectId});
  const send = await factories.createWorkflowStep({
    workflowId: workflow.id,
    type: WorkflowStepType.SEND_EMAIL,
    templateId: template.id,
  });
  await prisma.workflowTransition.create({data: {fromStepId: from, toStepId: send.id}});

  const execution = await prisma.workflowExecution.create({
    data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
  });
  await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);

  return {
    executionId: execution.id,
    delays,
    sendStepId: send.id,
    endDelay: (index = 0) => WorkflowExecutionService.processDelayEnd(execution.id, delays[index]!),
  };
}

/**
 * Plunk Lite: every delay ends through its own job, which follows the step connected after it when
 * the delay runs out, and claims the run only while it still waits on that very delay.
 */
describe('WorkflowExecutionService - a delay with a step after it (Plunk Lite)', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const status = async (executionId: string) =>
    (await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status;
  const emails = (executionId: string) => prisma.email.count({where: {workflowExecutionId: executionId}});

  it('schedules the end of the delay, and sends the email when it runs out', async () => {
    const route = await createRoute(0);
    expect(QueueService.queueWorkflowDelayEnd).toHaveBeenCalledTimes(1);

    await route.endDelay();

    expect(await emails(route.executionId)).toBe(1);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('completes the run when the step after the delay was deleted while it waited', async () => {
    const route = await createRoute(0);
    await prisma.workflowStep.delete({where: {id: route.sendStepId}});

    await route.endDelay();

    expect(await emails(route.executionId)).toBe(0);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('fails the run, and says so, when the delay itself was deleted while it waited', async () => {
    const route = await createRoute(0);
    await prisma.workflowStep.delete({where: {id: route.delays[0]!}});

    await route.endDelay();

    const run = await prisma.workflowExecution.findUniqueOrThrow({where: {id: route.executionId}});
    expect(run).toMatchObject({status: WorkflowExecutionStatus.FAILED, exitReason: 'Step deleted'});
    expect(await emails(route.executionId)).toBe(0);
  });

  it('sends once when the delay ends twice', async () => {
    const route = await createRoute(0);

    await Promise.all([route.endDelay(), route.endDelay()]);

    expect(await emails(route.executionId)).toBe(1);
  });

  it('waits out a second delay before the email, and ignores a late copy of the first', async () => {
    const route = await createRoute(1);

    await route.endDelay(0);
    expect(await emails(route.executionId)).toBe(0);
    expect(QueueService.queueWorkflowDelayEnd).toHaveBeenCalledTimes(2);

    // A late copy of the first delay's job while the run waits on the second
    await route.endDelay(0);
    expect(await emails(route.executionId)).toBe(0);

    await route.endDelay(1);
    expect(await emails(route.executionId)).toBe(1);
  });

  it('ends the delay when an old job for the deleted step after it runs', async () => {
    const route = await createRoute(0);
    await runOut(route.executionId, route.delays[0]!);
    await prisma.workflowStep.delete({where: {id: route.sendStepId}});

    // A process-step job queued before delays ended through delay-end
    await WorkflowExecutionService.resumeLegacyStep(route.executionId);

    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('follows a step inserted after the delay when an old job for the step it replaced runs', async () => {
    const route = await createRoute(0);
    await runOut(route.executionId, route.delays[0]!);
    const template = await factories.createTemplate({projectId});
    const inserted = await factories.createWorkflowStep({
      workflowId: (await prisma.workflowExecution.findUniqueOrThrow({where: {id: route.executionId}})).workflowId,
      type: WorkflowStepType.SEND_EMAIL,
      templateId: template.id,
    });
    await prisma.workflowTransition.deleteMany({where: {fromStepId: route.delays[0]!}});
    await prisma.workflowTransition.create({data: {fromStepId: route.delays[0]!, toStepId: inserted.id}});
    await prisma.workflowTransition.create({data: {fromStepId: inserted.id, toStepId: route.sendStepId}});

    await WorkflowExecutionService.resumeLegacyStep(route.executionId);

    expect(await emails(route.executionId)).toBe(2);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('queues the end of a delay that has not run out when an old job for it runs early', async () => {
    const route = await createRoute(0);
    vi.mocked(QueueService.queueWorkflowDelayEnd).mockClear();

    await WorkflowExecutionService.resumeLegacyStep(route.executionId);

    expect(QueueService.queueWorkflowDelayEnd).toHaveBeenCalledTimes(1);
    const [, stepId, , left] = vi.mocked(QueueService.queueWorkflowDelayEnd).mock.calls[0]!;
    expect(stepId).toBe(route.delays[0]);
    expect(left).toBeGreaterThan(0);
    expect(await emails(route.executionId)).toBe(0);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('leaves alone a run an old job finds already moved on', async () => {
    const route = await createRoute(0);
    await route.endDelay();

    await WorkflowExecutionService.resumeLegacyStep(route.executionId);

    expect(await emails(route.executionId)).toBe(1);
  });
});

/** As if the delay the run waits on ran out a minute ago */
async function runOut(executionId: string, delayStepId: string) {
  await prisma.workflowStepExecution.updateMany({
    where: {executionId, stepId: delayStepId},
    data: {output: {resumeAt: new Date(Date.now() - 60_000).toISOString()}},
  });
}
