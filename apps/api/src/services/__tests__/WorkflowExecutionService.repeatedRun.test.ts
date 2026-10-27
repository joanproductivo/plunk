import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {QueueService} from '../QueueService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';

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

const prisma = getPrismaClient();
let projectId: string;
let contactId: string;

/** A workflow TRIGGER → each of `types` in a row, and a RUNNING run of it on the trigger */
async function createRoute(...types: {type: WorkflowStepType; config?: Record<string, unknown>}[]) {
  const workflow = await factories.createWorkflow({projectId});
  const trigger = await prisma.workflowStep.findFirstOrThrow({
    where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
  });
  const template = await factories.createTemplate({projectId});
  const steps = [];
  let from = trigger.id;
  for (const {type, config} of types) {
    const step = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type,
      config,
      templateId: type === WorkflowStepType.SEND_EMAIL ? template.id : undefined,
    });
    await prisma.workflowTransition.create({data: {fromStepId: from, toStepId: step.id}});
    steps.push(step.id);
    from = step.id;
  }
  const execution = await prisma.workflowExecution.create({
    data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
  });
  return {
    executionId: execution.id,
    triggerId: trigger.id,
    steps,
    run: (stepId = trigger.id) => WorkflowExecutionService.processStepExecution(execution.id, stepId),
  };
}

const SEND = {type: WorkflowStepType.SEND_EMAIL};
const emails = (executionId: string) => prisma.email.count({where: {workflowExecutionId: executionId}});
const status = async (executionId: string) =>
  (await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status;

/**
 * Plunk Lite: a job repeated after a restart in the middle of a run carries on from what the run
 * already did, without doing it again.
 */
describe('WorkflowExecutionService - a repeated run of the same steps', () => {
  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends each email once when a chain is run again after a restart cut it short', async () => {
    const route = await createRoute(SEND, SEND);
    await route.run();
    expect(await emails(route.executionId)).toBe(2);

    // As if the server stopped after the last send, before marking it done
    await prisma.workflowExecution.update({
      where: {id: route.executionId},
      data: {status: WorkflowExecutionStatus.RUNNING, completedAt: null},
    });
    await prisma.workflowStepExecution.updateMany({
      where: {executionId: route.executionId, stepId: route.steps[1]},
      data: {status: StepExecutionStatus.RUNNING},
    });

    await route.run();

    expect(await emails(route.executionId)).toBe(2);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.COMPLETED);
  });

  it('keeps the branch a condition took when it is run again', async () => {
    const contact = await prisma.contact.update({where: {id: contactId}, data: {data: {vip: true}}});
    const workflow = await factories.createWorkflow({projectId});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const condition = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.CONDITION,
      config: {field: 'data.vip', operator: 'equals', value: true},
    });
    const template = await factories.createTemplate({projectId});
    const yes = await factories.createWorkflowStep({workflowId: workflow.id, type: SEND.type, templateId: template.id});
    const no = await factories.createWorkflowStep({workflowId: workflow.id, type: SEND.type, templateId: template.id});
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: condition.id}});
    await prisma.workflowTransition.create({
      data: {fromStepId: condition.id, toStepId: yes.id, condition: toPrismaJson({branch: 'yes'}), priority: 1},
    });
    await prisma.workflowTransition.create({
      data: {fromStepId: condition.id, toStepId: no.id, condition: toPrismaJson({branch: 'no'}), priority: 2},
    });
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId: contact.id, status: WorkflowExecutionStatus.RUNNING},
    });
    await WorkflowExecutionService.processStepExecution(execution.id, trigger.id);

    // The contact changes, and the run is repeated from the condition
    await prisma.contact.update({where: {id: contact.id}, data: {data: {vip: false}}});
    await prisma.workflowExecution.update({where: {id: execution.id}, data: {status: WorkflowExecutionStatus.RUNNING}});
    await WorkflowExecutionService.processStepExecution(execution.id, condition.id);

    const ran = await prisma.workflowStepExecution.findMany({
      where: {executionId: execution.id},
      select: {stepId: true},
    });
    expect(ran.map(step => step.stepId)).toContain(yes.id);
    expect(ran.map(step => step.stepId)).not.toContain(no.id);
    expect(await emails(execution.id)).toBe(1);
  });

  it('does nothing for a copy of a job when the run already waits further along', async () => {
    const route = await createRoute(SEND, {type: WorkflowStepType.DELAY, config: {amount: 1, unit: 'hours'}}, SEND);
    await route.run();
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);

    await route.run(route.steps[0]);

    expect(await emails(route.executionId)).toBe(1);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('sets up a wait once when the run reaches it again', async () => {
    const route = await createRoute({type: WorkflowStepType.WAIT_FOR_EVENT, config: {eventName: 'x', timeout: 60}});
    await route.run();
    await prisma.workflowExecution.update({
      where: {id: route.executionId},
      data: {status: WorkflowExecutionStatus.RUNNING},
    });

    await route.run();

    expect(QueueService.queueWorkflowTimeout).toHaveBeenCalledTimes(1);
    expect(
      await prisma.workflowStepExecution.count({where: {executionId: route.executionId, stepId: route.steps[0]}}),
    ).toBe(1);
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
  });

  it('resumes a waiting run once when two copies of an old job for it run at the same time', async () => {
    const route = await createRoute({type: WorkflowStepType.DELAY, config: {amount: 1, unit: 'hours'}}, SEND);
    await route.run();
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
    // The delay ran out a minute ago
    await prisma.workflowStepExecution.updateMany({
      where: {executionId: route.executionId, stepId: route.steps[0]},
      data: {output: {resumeAt: new Date(Date.now() - 60_000).toISOString()}},
    });

    // Two copies of a process-step job from before delays ended through their own job
    await Promise.all([
      WorkflowExecutionService.resumeLegacyStep(route.executionId),
      WorkflowExecutionService.resumeLegacyStep(route.executionId),
    ]);

    expect(await emails(route.executionId)).toBe(1);
  });

  it('never pulls a run that waits further along back out of its wait', async () => {
    const route = await createRoute(SEND, {type: WorkflowStepType.DELAY, config: {amount: 1, unit: 'hours'}}, SEND);
    await route.run();
    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
    const execution = await prisma.workflowExecution.findUniqueOrThrow({
      where: {id: route.executionId},
      include: {contact: true, workflow: true},
    });
    const first = await prisma.workflowStep.findUniqueOrThrow({
      where: {id: route.steps[0]},
      include: {outgoingTransitions: {include: {toStep: true}}},
    });

    // A late copy that read the run RUNNING moves on from the first email it finds done
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (WorkflowExecutionService as any).processNextSteps(execution, first, {});

    expect(await status(route.executionId)).toBe(WorkflowExecutionStatus.WAITING);
    expect(await emails(route.executionId)).toBe(1);
  });
});
