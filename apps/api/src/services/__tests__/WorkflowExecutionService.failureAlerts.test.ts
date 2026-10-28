import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as servicePrisma} from '../../database/prisma';
import {FailureAlertService} from '../FailureAlertService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';

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

vi.mock('../SESService', () => ({
  sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'})),
}));

/** A workflow that fails is reported to the project's failure alerts once, however deep it failed. */
describe('WorkflowExecutionService - failure alerts', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, email: 'ana@example.net'})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** TRIGGER → UPDATE_CONTACT → WEBHOOK to a private address, which the engine refuses to call */
  async function runFailingWorkflow() {
    const workflow = await factories.createWorkflow({projectId, name: 'Welcome'});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const update = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.UPDATE_CONTACT,
      config: {updates: {stage: 'welcomed'}},
    });
    const webhook = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'http://127.0.0.1/hook', method: 'POST'},
    });
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: update.id}});
    await prisma.workflowTransition.create({data: {fromStepId: update.id, toStepId: webhook.id}});
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
    });

    await expect(WorkflowExecutionService.processStepExecution(execution.id, trigger.id)).rejects.toThrow(/private/i);
    return {workflowId: workflow.id, executionId: execution.id};
  }

  it('records a failure in the third step once', async () => {
    const {workflowId, executionId} = await runFailingWorkflow();

    const failures = await prisma.plunkLiteFailure.findMany({where: {projectId}});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sourceKey: `workflow:${workflowId}`,
      label: 'Welcome',
      count: 1,
      lastContactEmail: 'ana@example.net',
    });
    expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status).toBe(
      WorkflowExecutionStatus.FAILED,
    );
  });

  it('records a webhook answered with a 5xx as the failure of its run (Plunk Lite)', async () => {
    vi.spyOn(WorkflowExecutionService as never, 'safeFetch').mockResolvedValue(
      new Response('down', {status: 503}) as never,
    );
    const workflow = await factories.createWorkflow({projectId, name: 'Notify the club'});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const webhook = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://example.com/hook', method: 'POST'},
    });
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: webhook.id}});
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
    });

    await expect(WorkflowExecutionService.processStepExecution(execution.id, trigger.id)).rejects.toThrow(
      'Webhook responded with HTTP 503',
    );

    const stepRun = await prisma.workflowStepExecution.findFirstOrThrow({
      where: {executionId: execution.id, stepId: webhook.id},
    });
    expect(stepRun).toMatchObject({status: 'FAILED', error: 'Webhook responded with HTTP 503'});
    expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: execution.id}})).status).toBe(
      WorkflowExecutionStatus.FAILED,
    );
    expect(await prisma.plunkLiteFailure.findMany({where: {projectId}})).toEqual([
      expect.objectContaining({sourceKey: `workflow:${workflow.id}`, label: 'Notify the club', count: 1}),
    ]);
  });

  it("fails as before, with the step's own error, when the failure cannot be recorded", async () => {
    vi.spyOn(servicePrisma, '$queryRaw').mockRejectedValue(new Error('alerts down'));

    const {executionId} = await runFailingWorkflow();

    expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status).toBe(
      WorkflowExecutionStatus.FAILED,
    );
  });

  it('records a job that ran out of attempts only when the execution did not already fail', async () => {
    const {executionId} = await runFailingWorkflow();
    await FailureAlertService.recordWorkflowJob(executionId, 'Step not found');
    expect((await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}})).count).toBe(1);

    const workflow = await factories.createWorkflow({projectId, name: 'Stuck'});
    const stuck = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING},
    });
    await FailureAlertService.recordWorkflowJob(stuck.id, 'Step not found');
    expect(await prisma.plunkLiteFailure.findFirst({where: {sourceKey: `workflow:${workflow.id}`}})).toMatchObject({
      label: 'Stuck',
      lastError: 'Step not found',
    });

    // A timeout job failing on an execution that already finished is not a failing workflow
    const done = await factories.createWorkflow({projectId, name: 'Done'});
    const finished = await prisma.workflowExecution.create({
      data: {workflowId: done.id, contactId, status: WorkflowExecutionStatus.COMPLETED},
    });
    await FailureAlertService.recordWorkflowJob(finished.id, 'stepExecutionId is required');
    expect(await prisma.plunkLiteFailure.findFirst({where: {sourceKey: `workflow:${done.id}`}})).toBeNull();
  });

  it('records only the resumed workflow when a step fails in another execution it resumed through an event', async () => {
    const subscribed = await factories.createContact({projectId, email: 'leo@example.net', subscribed: true});

    /** A workflow with `steps` after its trigger, started for the subscribed contact */
    async function start(name: string, steps: Array<{type: WorkflowStepType; config: Record<string, unknown>}>) {
      const workflow = await factories.createWorkflow({projectId, name});
      const trigger = await prisma.workflowStep.findFirstOrThrow({
        where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
      });
      let from = trigger.id;
      for (const step of steps) {
        const created = await factories.createWorkflowStep({workflowId: workflow.id, ...step});
        await prisma.workflowTransition.create({data: {fromStepId: from, toStepId: created.id}});
        from = created.id;
      }
      const execution = await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId: subscribed.id,
          status: WorkflowExecutionStatus.RUNNING,
          currentStepId: trigger.id,
        },
      });
      return {
        workflowId: workflow.id,
        run: () => WorkflowExecutionService.processStepExecution(execution.id, trigger.id),
      };
    }

    const waiting = await start('Goodbye', [
      {type: WorkflowStepType.WAIT_FOR_EVENT, config: {eventName: 'contact.unsubscribed', timeout: 3600}},
      {type: WorkflowStepType.WEBHOOK, config: {url: 'http://127.0.0.1/hook', method: 'POST'}},
    ]);
    await waiting.run();
    const unsubscribing = await start('Unsubscribe', [
      {type: WorkflowStepType.UPDATE_CONTACT, config: {subscriptionAction: 'unsubscribe'}},
    ]);

    // Plunk Lite: the resumed run keeps its failure; the one that resumed it carries on
    await unsubscribing.run();

    const sources = (await prisma.plunkLiteFailure.findMany({where: {projectId}})).map(failure => failure.sourceKey);
    expect(sources).toEqual([`workflow:${waiting.workflowId}`]);
  });
});
