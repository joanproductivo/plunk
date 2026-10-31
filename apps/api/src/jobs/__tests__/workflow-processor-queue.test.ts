import http from 'node:http';
import type {AddressInfo} from 'node:net';

import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import type {Worker} from 'bullmq';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {QueueService, workflowQueue} from '../../services/QueueService';
import {WEBHOOK_DELIVERY_HEADER} from '../../services/WebhookDelivery';
import {WorkflowExecutionService} from '../../services/WorkflowExecutionService';
import {WorkflowRecoveryService} from '../../services/WorkflowRecoveryService';
import {WorkflowService} from '../../services/WorkflowService';
import {createWorkflowWorker} from '../workflow-processor-queue';

vi.mock('../../services/SESService', () => ({sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'}))}));

/**
 * Plunk Lite: a webhook's retries through the real worker, queue and Redis, against a receiver on
 * this machine. The first retry takes its real 3 s.
 */
describe('workflow worker - webhook retries', () => {
  const prisma = getPrismaClient();
  const received: http.IncomingHttpHeaders[] = [];
  let answers: number[] = [];
  let port = 0;
  let worker: Worker;
  let projectId: string;
  let contactId: string;

  const receiver = http.createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    request.on('end', () => {
      response.writeHead(answers.shift() ?? 200, {'content-type': 'application/json'});
      response.end('{}');
    });
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    port = (receiver.address() as AddressInfo).port;
    worker = createWorkflowWorker();
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    receiver.closeAllConnections();
    receiver.close();
  });

  beforeEach(async () => {
    received.length = 0;
    answers = [];
    // The receiver is on this machine, which the engine refuses to call
    vi.spyOn(WorkflowExecutionService as never, 'isPrivateIp').mockReturnValue(false as never);
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  /** TRIGGER → WEBHOOK, with a run on the trigger */
  async function setup() {
    const workflow = await factories.createWorkflow({projectId, enabled: true});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const webhook = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: `http://127.0.0.1:${port}/in`, method: 'POST'},
    });
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: webhook.id}});
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
    });
    return {workflow, trigger, webhook, executionId: execution.id};
  }

  const stepOf = (executionId: string, stepId: string) =>
    prisma.workflowStepExecution.findFirstOrThrow({where: {executionId, stepId}});

  const expectRunToBecome = (executionId: string, status: WorkflowExecutionStatus, timeout = 10_000) =>
    vi.waitFor(
      async () =>
        expect((await prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}})).status).toBe(status),
      {timeout, interval: 100},
    );

  it('runs the next attempt from its job, with the same delivery ID, and completes the run', async () => {
    answers = [503, 200];
    const {trigger, webhook, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

    const {id} = await stepOf(executionId, webhook.id);
    expect(await QueueService.isWebhookRetryPending(id, 1)).toBe(true);
    await expectRunToBecome(executionId, WorkflowExecutionStatus.COMPLETED);

    expect(received.map(headers => headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()])).toEqual([id, id]);
    expect(await stepOf(executionId, webhook.id)).toMatchObject({status: StepExecutionStatus.COMPLETED, error: null});
    await vi.waitFor(async () => expect(await QueueService.isWebhookRetryPending(id, 1)).toBe(false));
  }, 15_000);

  it('queues again an attempt whose job was lost, once the sweep finds it overdue', async () => {
    answers = [503, 200];
    const {trigger, webhook, executionId} = await setup();
    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    const {id} = await stepOf(executionId, webhook.id);
    await (await workflowQueue.getJob(`workflow-webhook-retry-${id}-1`))!.remove();
    const overdue = new Date(Date.now() - 31 * 60_000);
    await prisma.workflowStepExecution.update({where: {id}, data: {executeAfter: overdue}});
    // Raw, so Prisma does not stamp updatedAt with now
    await prisma.$executeRaw`UPDATE "workflow_executions" SET "updatedAt" = ${new Date(overdue.getTime() - 1000)} WHERE "id" = ${executionId}`;

    await WorkflowRecoveryService.recoverWaits();

    await expectRunToBecome(executionId, WorkflowExecutionStatus.COMPLETED);
    expect(received).toHaveLength(2);
  }, 15_000);

  it('does not queue an attempt again while its job is still to run', async () => {
    const {trigger, webhook, executionId} = await setup();
    answers = [503];
    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    const {id} = await stepOf(executionId, webhook.id);

    expect(await QueueService.ensureWebhookRetry(executionId, webhook.id, id, 1)).toBe(false);

    await (await workflowQueue.getJob(`workflow-webhook-retry-${id}-1`))!.remove();
  });

  it('carries on a failed run someone retried, from its job', async () => {
    answers = [404, 200];
    const {workflow, trigger, webhook, executionId} = await setup();
    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow('HTTP 404');
    const {id} = await stepOf(executionId, webhook.id);

    await WorkflowService.retryExecution(projectId, workflow.id, executionId);

    await expectRunToBecome(executionId, WorkflowExecutionStatus.COMPLETED);
    expect(received.map(headers => headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()])).toEqual([id, id]);
  });
});
