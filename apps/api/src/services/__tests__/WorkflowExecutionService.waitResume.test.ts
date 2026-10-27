import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {prisma as servicePrisma} from '../../database/prisma';
import {EmailService} from '../EmailService';
import {QueueService} from '../QueueService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../QueueService', () => ({
  QueueService: {
    // Runs the queueing it is given, which here is a mock too
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
    queueWorkflowTimeout: vi.fn(async () => ({id: 'mock-timeout-job-id'})),
    cancelWorkflowTimeout: vi.fn(async () => true),
  },
}));

const EVENT = 'order.shipped';

type Run = Awaited<ReturnType<typeof createRun>>;

let projectId: string;
let contactId: string;
const prisma = getPrismaClient();

/** TRIGGER → WAIT_FOR_EVENT → SEND_EMAIL, started and parked on the wait (unless an event already took it). */
async function createRun({parked = true} = {}) {
  const workflow = await factories.createWorkflow({projectId});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  const wait = await factories.createWorkflowStep({
    workflowId: workflow.id,
    type: WorkflowStepType.WAIT_FOR_EVENT,
    config: {eventName: EVENT, timeout: 3600},
  });
  const template = await factories.createTemplate({projectId});
  const send = await factories.createWorkflowStep({
    workflowId: workflow.id,
    type: WorkflowStepType.SEND_EMAIL,
    templateId: template.id,
  });
  await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: wait.id}});
  await prisma.workflowTransition.create({data: {fromStepId: wait.id, toStepId: send.id}});

  const execution = await prisma.workflowExecution.create({
    data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
  });
  await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);

  const waitExecution = () =>
    prisma.workflowStepExecution.findFirstOrThrow({where: {executionId: execution.id, stepId: wait.id}});
  if (parked) {
    expect((await waitExecution()).status).toBe(StepExecutionStatus.WAITING);
  }

  return {
    executionId: execution.id,
    sendStepId: send.id,
    waitExecution,
    timeOut: async () => WorkflowExecutionService.processTimeout(execution.id, wait.id, (await waitExecution()).id),
  };
}

/** How many times the step after the wait ran, and how many emails the run sent. */
async function outcome(run: Run) {
  const sends = await prisma.workflowStepExecution.count({
    where: {executionId: run.executionId, stepId: run.sendStepId},
  });
  const emails = await prisma.email.count({where: {workflowExecutionId: run.executionId}});
  return {sends, emails};
}

const once = {sends: 1, emails: 1};

const ship = () => WorkflowExecutionService.handleEvent(projectId, EVENT, contactId);

/**
 * A wait is resumed once, however many deliveries of its event reach it: the list of waits an
 * event reads can be stale by the time it gets to each of them.
 */
describe('WorkflowExecutionService - resuming a wait once', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves on once when the same event arrives twice at the same time', async () => {
    for (let round = 0; round < 5; round++) {
      const run = await createRun();

      await Promise.all([ship(), ship()]);

      expect(await outcome(run)).toEqual(once);
    }
  });

  it('moves on once when a resumed execution delivers the event again', async () => {
    const first = await createRun();
    const second = await createRun();

    // While the first execution is being resumed, the same event is tracked again (as a step of
    // the resumed execution can do) and resumes the second one.
    vi.spyOn(QueueService, 'cancelWorkflowTimeout').mockImplementationOnce(async () => {
      await ship();
    });

    await ship();

    expect(await outcome(first)).toEqual(once);
    expect(await outcome(second)).toEqual(once);
  });

  it('takes one way out when the event and the timeout arrive at the same time', async () => {
    const run = await createRun();

    await Promise.all([ship(), run.timeOut()]);

    expect(await outcome(run)).toEqual(once);
  });

  it('leaves a wait alone when its timeout read it before the event claimed it', async () => {
    const run = await createRun();
    const waiting = await servicePrisma.workflowStepExecution.findUniqueOrThrow({
      where: {id: (await run.waitExecution()).id},
      include: {execution: true, step: {include: {outgoingTransitions: {include: {toStep: true}}}}},
    });

    await ship();
    // The timeout job read the wait while it was still WAITING
    vi.spyOn(servicePrisma.workflowStepExecution, 'findUnique').mockResolvedValueOnce(waiting);
    await run.timeOut();

    expect(await outcome(run)).toEqual(once);
    expect((await run.waitExecution()).output).toMatchObject({eventName: EVENT, receivedAt: expect.any(String)});
  });

  it('moves on when the timeout job cannot be cancelled', async () => {
    const run = await createRun();

    // BullMQ refuses to remove a job another worker is running.
    vi.spyOn(QueueService, 'cancelWorkflowTimeout').mockRejectedValueOnce(
      new Error('Job could not be removed because it is locked by another worker'),
    );

    await ship();

    expect(await outcome(run)).toEqual(once);
    const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(status).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('moves on once when the event arrives while the wait is being set up (Plunk Lite)', async () => {
    // The event lands between setting up the wait and the step returning to processStepExecution
    vi.mocked(QueueService.queueWorkflowTimeout).mockImplementationOnce(async () => {
      await ship();
      return {id: 'mock-timeout-job-id'} as never;
    });

    const run = await createRun({parked: false});

    expect(await outcome(run)).toEqual(once);
    const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(status).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('sets up the run and its wait together, so a cut between them leaves neither (Plunk Lite)', async () => {
    const transaction = servicePrisma.$transaction.bind(servicePrisma);
    vi.spyOn(servicePrisma, '$transaction').mockImplementationOnce(((
      write: (tx: unknown) => Promise<unknown>,
      options: never,
    ) =>
      transaction(async tx => {
        await write(tx);
        throw new Error('server stopped');
      }, options)) as never);

    await expect(createRun({parked: false})).rejects.toThrow('server stopped');

    const run = await prisma.workflowExecution.findFirstOrThrow({
      where: {contactId},
      include: {stepExecutions: true},
    });
    expect(run.stepExecutions.map(step => step.status)).not.toContain(StepExecutionStatus.WAITING);
    expect(run.status).toBe(WorkflowExecutionStatus.FAILED);
  });

  it('claims the run with its wait, so a failure moving on leaves it running, not waiting (Plunk Lite)', async () => {
    const run = await createRun();
    vi.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WorkflowExecutionService as any,
      'processNextSteps',
    ).mockRejectedValueOnce(new Error('database gone'));
    vi.spyOn(servicePrisma.workflowExecution, 'updateMany').mockImplementation((() => {
      throw new Error('database gone');
    }) as never);

    await ship();

    vi.mocked(servicePrisma.workflowExecution.updateMany).mockRestore();
    const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(status).toBe(WorkflowExecutionStatus.RUNNING);
    expect((await run.waitExecution()).status).toBe(StepExecutionStatus.COMPLETED);
  });

  it('leaves a finished run with an old wait step alone when its event arrives (Plunk Lite)', async () => {
    const run = await createRun();
    await prisma.workflowExecution.update({
      where: {id: run.executionId},
      data: {status: WorkflowExecutionStatus.COMPLETED},
    });

    await ship();
    await run.timeOut();

    expect(await outcome(run)).toEqual({sends: 0, emails: 0});
    expect((await run.waitExecution()).status).toBe(StepExecutionStatus.WAITING);
  });

  it('never resumes a failed run, by its event or its timeout (Plunk Lite)', async () => {
    const run = await createRun();
    await prisma.workflowExecution.update({
      where: {id: run.executionId},
      data: {status: WorkflowExecutionStatus.FAILED},
    });

    await ship();
    await run.timeOut();

    expect(await outcome(run)).toEqual({sends: 0, emails: 0});
    const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(status).toBe(WorkflowExecutionStatus.FAILED);
  });

  it('keeps a run cancelled during its last step cancelled, not COMPLETED (Plunk Lite)', async () => {
    const run = await createRun();
    // A workflow's brake cancels the run while its last step sends
    const send = EmailService.sendWorkflowEmail.bind(EmailService);
    vi.spyOn(EmailService, 'sendWorkflowEmail').mockImplementationOnce(async (...args) => {
      await prisma.workflowExecution.update({
        where: {id: run.executionId},
        data: {status: WorkflowExecutionStatus.CANCELLED},
      });
      return send(...args);
    });

    await ship();

    const {status} = await prisma.workflowExecution.findUniqueOrThrow({where: {id: run.executionId}});
    expect(status).toBe(WorkflowExecutionStatus.CANCELLED);
  });

  it('resumes every run waiting for the event when one of them fails to move on (Plunk Lite)', async () => {
    const first = await createRun();
    const second = await createRun();
    // The first run's step after the wait was deleted meanwhile: moving it on throws
    const real = WorkflowExecutionService.processStepExecution.bind(WorkflowExecutionService);
    vi.spyOn(WorkflowExecutionService, 'processStepExecution').mockImplementation(async (executionId, stepId) => {
      if (executionId === first.executionId) throw new Error('moving on failed');
      return real(executionId, stepId);
    });

    await expect(ship()).resolves.toBeUndefined();

    const runs = await prisma.workflowExecution.findMany({
      where: {id: {in: [first.executionId, second.executionId]}},
      select: {id: true, status: true, exitReason: true},
    });
    const byId = Object.fromEntries(runs.map(run => [run.id, run]));
    expect(byId[first.executionId]).toMatchObject({
      status: WorkflowExecutionStatus.FAILED,
      exitReason: 'Resuming after the event failed',
    });
    expect(byId[second.executionId]!.status).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('resumes no wait for an event without a contact (Plunk Lite)', async () => {
    const run = await createRun();

    await WorkflowExecutionService.handleEvent(projectId, EVENT, undefined);

    expect(await outcome(run)).toEqual({sends: 0, emails: 0});
    expect((await run.waitExecution()).status).toBe(StepExecutionStatus.WAITING);
  });
});
