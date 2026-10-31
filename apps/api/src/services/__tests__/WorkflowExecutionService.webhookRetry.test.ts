import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as servicePrisma} from '../../database/prisma';
import {QueueService} from '../QueueService';
import {WEBHOOK_DELIVERY_HEADER, WEBHOOK_RETRY_DELAYS_MS} from '../WebhookDelivery';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {WorkflowService} from '../WorkflowService';

vi.mock('node:dns/promises', () => ({default: {lookup: vi.fn(async () => ({address: '1.2.3.4', family: 4}))}}));

vi.mock('../QueueService', () => ({
  QueueService: {
    queueWithoutWaiting: vi.fn(async (add: Promise<unknown>) => {
      await add.catch(() => undefined);
    }),
    queueWebhookRetry: vi.fn(async () => ({id: 'mock-retry'})),
    queueRetriedRun: vi.fn(async () => ({id: 'mock-resume'})),
    queueEmail: vi.fn(async () => ({id: 'mock-email-job-id'})),
  },
}));

vi.mock('../SESService', () => ({sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'}))}));

/** Plunk Lite: a webhook that fails for a reason that may pass tries again, on its own or by hand */
describe('WorkflowExecutionService - webhook retries', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;
  const fetchMock = vi.fn<typeof fetch>();

  const answer = (status: number) => async () => new Response(status === 204 ? null : '{}', {status});
  const networkDown = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), {code: 'ETIMEDOUT', address: '1.2.3.4', port: 443}),
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, email: 'ana@example.net'})).id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** TRIGGER → WEBHOOK → UPDATE_CONTACT, with a run on the trigger */
  async function setup(enabled = true) {
    const workflow = await factories.createWorkflow({projectId, name: 'Notify the club', enabled});
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
    });
    const webhook = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://club.example.com/in/TOKEN', method: 'POST'},
    });
    const after = await factories.createWorkflowStep({
      workflowId: workflow.id,
      type: WorkflowStepType.UPDATE_CONTACT,
      config: {updates: {notified: true}},
    });
    await prisma.workflowTransition.create({data: {fromStepId: trigger.id, toStepId: webhook.id}});
    await prisma.workflowTransition.create({data: {fromStepId: webhook.id, toStepId: after.id}});
    const execution = await prisma.workflowExecution.create({
      data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.RUNNING, currentStepId: trigger.id},
    });
    return {workflow, trigger, webhook, after, executionId: execution.id};
  }

  const runOf = (executionId: string) => prisma.workflowExecution.findUniqueOrThrow({where: {id: executionId}});
  const stepOf = (executionId: string, stepId: string) =>
    prisma.workflowStepExecution.findFirstOrThrow({where: {executionId, stepId}});
  const alerts = () => prisma.plunkLiteFailure.count({where: {projectId}});

  /** Make the scheduled attempt due, and run it as its job would */
  async function runDueAttempt(executionId: string, stepId: string) {
    const step = await stepOf(executionId, stepId);
    await prisma.workflowStepExecution.update({
      where: {id: step.id},
      data: {executeAfter: new Date(Date.now() - 1000)},
    });
    await WorkflowExecutionService.processWebhookRetry(executionId, stepId, step.id);
  }

  it('waits 3 s after a response of 503, without an alert, and the steps after it do not run yet', async () => {
    fetchMock.mockImplementation(answer(503));
    const {trigger, webhook, after, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.WAITING);
    const step = await stepOf(executionId, webhook.id);
    expect(step).toMatchObject({
      status: StepExecutionStatus.SCHEDULED,
      error: 'Webhook responded with HTTP 503',
      output: {webhookAttempts: 1},
    });
    expect(step.executeAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(QueueService.queueWebhookRetry).toHaveBeenCalledWith(executionId, webhook.id, step.id, 1, 3_000);
    expect(await prisma.workflowStepExecution.count({where: {executionId, stepId: after.id}})).toBe(0);
    expect(await alerts()).toBe(0);
  });

  it('says what happened on a network error, by host only, and waits 30 s after the second', async () => {
    fetchMock.mockImplementation(networkDown);
    const {trigger, webhook, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    await runDueAttempt(executionId, webhook.id);

    const step = await stepOf(executionId, webhook.id);
    expect(step.error).toBe('Connection to club.example.com failed: ETIMEDOUT 1.2.3.4:443');
    expect(step.output).toEqual({webhookAttempts: 2});
    expect(QueueService.queueWebhookRetry).toHaveBeenLastCalledWith(executionId, webhook.id, step.id, 2, 30_000);
  });

  it('fails at once, with an alert, on an answer that repeating would not change', async () => {
    fetchMock.mockImplementation(answer(401));
    const {trigger, webhook, executionId} = await setup();

    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow(
      'Webhook responded with HTTP 401',
    );

    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.FAILED);
    expect((await stepOf(executionId, webhook.id)).status).toBe(StepExecutionStatus.FAILED);
    expect(QueueService.queueWebhookRetry).not.toHaveBeenCalled();
    expect(await alerts()).toBe(1);
  });

  it('completes on a later attempt, carries on, and keeps no error of the earlier ones', async () => {
    fetchMock.mockImplementationOnce(answer(503)).mockImplementationOnce(networkDown).mockImplementation(answer(204));
    const {trigger, webhook, after, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    await runDueAttempt(executionId, webhook.id);
    await runDueAttempt(executionId, webhook.id);

    const step = await stepOf(executionId, webhook.id);
    expect(step).toMatchObject({status: StepExecutionStatus.COMPLETED, error: null, executeAfter: null});
    expect(step.output).toMatchObject({statusCode: 204});
    expect((await stepOf(executionId, after.id)).status).toBe(StepExecutionStatus.COMPLETED);
    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.COMPLETED);
    expect(await alerts()).toBe(0);
  });

  it('sends the same delivery ID on every attempt, whatever header the step sets', async () => {
    fetchMock.mockImplementationOnce(answer(503)).mockImplementation(answer(204));
    const {trigger, webhook, executionId} = await setup();
    await prisma.workflowStep.update({
      where: {id: webhook.id},
      data: {
        config: {url: 'https://club.example.com/in', method: 'POST', headers: {'x-plunk-delivery-id': 'forged'}},
      },
    });
    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    await runDueAttempt(executionId, webhook.id);

    const {id} = await stepOf(executionId, webhook.id);
    const sent = fetchMock.mock.calls.map(([, init]) => init!.headers as Record<string, string>);
    expect(sent).toHaveLength(2);
    expect(sent.map(headers => headers[WEBHOOK_DELIVERY_HEADER])).toEqual([id, id]);
    expect(sent[0]!['x-plunk-delivery-id']).toBeUndefined();
  });

  it('fails, with one alert, once every attempt is used up', async () => {
    fetchMock.mockImplementation(answer(503));
    const {trigger, webhook, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
    for (let i = 1; i < WEBHOOK_RETRY_DELAYS_MS.length; i++) {
      await runDueAttempt(executionId, webhook.id);
    }
    expect(await alerts()).toBe(0);
    expect(QueueService.queueWebhookRetry).toHaveBeenCalledTimes(WEBHOOK_RETRY_DELAYS_MS.length);

    await expect(runDueAttempt(executionId, webhook.id)).rejects.toThrow('Webhook responded with HTTP 503');

    expect(fetchMock).toHaveBeenCalledTimes(WEBHOOK_RETRY_DELAYS_MS.length + 1);
    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.FAILED);
    expect((await stepOf(executionId, webhook.id)).status).toBe(StepExecutionStatus.FAILED);
    expect(await alerts()).toBe(1);
  });

  it('does not read the body of a refusal: a 401 cut short is still a refusal', async () => {
    const cutShort = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('terminated', {cause: Object.assign(new Error('x'), {code: 'UND_ERR_SOCKET'})}));
      },
    });
    fetchMock.mockImplementation(async () => new Response(cutShort, {status: 401}));
    const {trigger, executionId} = await setup();

    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow(
      'Webhook responded with HTTP 401',
    );

    expect(QueueService.queueWebhookRetry).not.toHaveBeenCalled();
  });

  it('tries again when a good answer is cut short, without the URL in what it says', async () => {
    const cutShort = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('terminated', {cause: Object.assign(new Error('x'), {code: 'UND_ERR_SOCKET'})}));
      },
    });
    fetchMock.mockImplementation(async () => new Response(cutShort, {status: 200}));
    const {trigger, webhook, executionId} = await setup();

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

    expect(await stepOf(executionId, webhook.id)).toMatchObject({
      status: StepExecutionStatus.SCHEDULED,
      error: 'Connection to club.example.com failed: UND_ERR_SOCKET',
    });
  });

  it('tries again after a redirect that ends in a 503, and not after one to a private address', async () => {
    const redirectTo = (location: string) => async () => new Response(null, {status: 302, headers: {location}});
    fetchMock.mockImplementationOnce(redirectTo('https://other.example.com/in')).mockImplementationOnce(answer(503));
    const first = await setup();
    await WorkflowExecutionService.processStepExecution(first.executionId, first.trigger.id);
    expect((await stepOf(first.executionId, first.webhook.id)).status).toBe(StepExecutionStatus.SCHEDULED);

    fetchMock.mockImplementationOnce(redirectTo('http://127.0.0.1/in'));
    const second = await setup();
    await expect(WorkflowExecutionService.processStepExecution(second.executionId, second.trigger.id)).rejects.toThrow(
      'private/internal IP address',
    );
    expect((await stepOf(second.executionId, second.webhook.id)).status).toBe(StepExecutionStatus.FAILED);
  });

  it('never stores a Location it cannot parse, which Node would report with the URL and its token', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(null, {status: 302, headers: {location: 'http://['}}));
    const {trigger, webhook, executionId} = await setup();

    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow(
      'Redirect with an invalid Location from club.example.com',
    );

    expect((await stepOf(executionId, webhook.id)).error).not.toContain('TOKEN');
  });

  it('marks a GET as a delivery too, and signs nothing it does not send', async () => {
    fetchMock.mockImplementation(answer(204));
    const {trigger, webhook, executionId} = await setup();
    await prisma.workflowStep.update({
      where: {id: webhook.id},
      data: {config: {url: 'https://club.example.com/in', method: 'GET'}},
    });

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

    const [, init] = fetchMock.mock.lastCall!;
    expect(init!.body).toBeUndefined();
    const {id} = await stepOf(executionId, webhook.id);
    expect((init!.headers as Record<string, string>)[WEBHOOK_DELIVERY_HEADER]).toBe(id);
  });

  it('fails the step, with no alert, and leaves a run cancelled during the attempt', async () => {
    const {workflow, trigger, webhook, executionId} = await setup();
    fetchMock.mockImplementation(async () => {
      await WorkflowService.cancelExecution(projectId, workflow.id, executionId);
      return new Response('{}', {status: 503});
    });

    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow(
      'Webhook responded with HTTP 503',
    );

    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.CANCELLED);
    expect((await stepOf(executionId, webhook.id)).status).toBe(StepExecutionStatus.FAILED);
    expect(QueueService.queueWebhookRetry).not.toHaveBeenCalled();
    expect(await alerts()).toBe(0);
  });

  it('does not pull back a run a copy of the attempt moved on, keeping the result', async () => {
    const {trigger, webhook, after, executionId} = await setup();
    fetchMock.mockImplementationOnce(async () => {
      // The copy of this attempt that got through while this one waited for its answer
      const step = await stepOf(executionId, webhook.id);
      await prisma.workflowStepExecution.update({
        where: {id: step.id},
        data: {status: StepExecutionStatus.COMPLETED, output: {statusCode: 200}},
      });
      await prisma.workflowExecution.update({where: {id: executionId}, data: {currentStepId: after.id}});
      return new Response('{}', {status: 503});
    });

    await WorkflowExecutionService.processStepExecution(executionId, trigger.id).catch(() => undefined);

    expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.RUNNING);
    expect(await stepOf(executionId, webhook.id)).toMatchObject({
      status: StepExecutionStatus.COMPLETED,
      output: {statusCode: 200},
    });
    expect(QueueService.queueWebhookRetry).not.toHaveBeenCalled();
  });

  it('fails with what went wrong with the request when the retry cannot be scheduled', async () => {
    fetchMock.mockImplementation(answer(503));
    const {trigger, webhook, executionId} = await setup();
    const transaction = vi
      .spyOn(servicePrisma, '$transaction')
      .mockRejectedValueOnce(new Error('Can not reach database at db-host:5432'));

    await expect(WorkflowExecutionService.processStepExecution(executionId, trigger.id)).rejects.toThrow(
      'Webhook responded with HTTP 503',
    );
    transaction.mockRestore();

    expect((await stepOf(executionId, webhook.id)).error).toBe('Webhook responded with HTTP 503');
  });

  describe('processWebhookRetry', () => {
    it('does nothing before the attempt is due, for a copy of an earlier job', async () => {
      fetchMock.mockImplementation(answer(503));
      const {trigger, webhook, executionId} = await setup();
      await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
      const step = await stepOf(executionId, webhook.id);

      await WorkflowExecutionService.processWebhookRetry(executionId, webhook.id, step.id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.WAITING);
    });

    it('does nothing for a run cancelled meanwhile, and leaves it cancelled', async () => {
      fetchMock.mockImplementation(answer(503));
      const {workflow, trigger, webhook, executionId} = await setup();
      await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
      await WorkflowService.cancelExecution(projectId, workflow.id, executionId);

      await runDueAttempt(executionId, webhook.id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.CANCELLED);
      expect((await stepOf(executionId, webhook.id)).status).toBe(StepExecutionStatus.SCHEDULED);
    });

    it('does nothing once the step was deleted: the sweep fails the run', async () => {
      fetchMock.mockImplementation(answer(503));
      const {trigger, webhook, executionId} = await setup();
      await WorkflowExecutionService.processStepExecution(executionId, trigger.id);
      const {id} = await stepOf(executionId, webhook.id);
      await prisma.workflowStep.delete({where: {id: webhook.id}});

      await WorkflowExecutionService.processWebhookRetry(executionId, webhook.id, id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await runOf(executionId)).toMatchObject({status: WorkflowExecutionStatus.WAITING, currentStepId: null});
    });

    it('runs an attempt only once for two copies of the job', async () => {
      fetchMock.mockImplementationOnce(answer(503)).mockImplementation(answer(204));
      const {trigger, webhook, executionId} = await setup();
      await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

      await runDueAttempt(executionId, webhook.id);
      const {id} = await stepOf(executionId, webhook.id);
      await WorkflowExecutionService.processWebhookRetry(executionId, webhook.id, id);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('retrying a failed run by hand', () => {
    async function failedRun(status = 401) {
      fetchMock.mockImplementation(answer(status));
      const run = await setup();
      await WorkflowExecutionService.processStepExecution(run.executionId, run.trigger.id).catch(() => undefined);
      vi.mocked(QueueService.queueRetriedRun).mockClear();
      return run;
    }

    /** What the job the retry queues does */
    const resume = (executionId: string, stepId: string) =>
      WorkflowExecutionService.processStepExecution(executionId, stepId);

    it('claims the run, keeps its start and queues the step it stopped on', async () => {
      const {workflow, webhook, executionId} = await failedRun();
      const before = await runOf(executionId);

      const retried = await WorkflowService.retryExecution(projectId, workflow.id, executionId);

      expect(retried).toMatchObject({status: WorkflowExecutionStatus.RUNNING, completedAt: null, exitReason: null});
      expect(retried.startedAt).toEqual(before.startedAt);
      expect(QueueService.queueRetriedRun).toHaveBeenCalledWith(executionId, webhook.id);
      expect(await stepOf(executionId, webhook.id)).toMatchObject({
        status: StepExecutionStatus.PENDING,
        error: null,
        output: {webhookManual: true},
      });
    });

    it('reuses the delivery ID, carries on after it and completes the run', async () => {
      const {workflow, webhook, after, executionId} = await failedRun();
      const {id} = await stepOf(executionId, webhook.id);
      await WorkflowService.retryExecution(projectId, workflow.id, executionId);
      fetchMock.mockImplementation(answer(204));

      await resume(executionId, webhook.id);

      const headers = fetchMock.mock.lastCall![1]!.headers as Record<string, string>;
      expect(headers[WEBHOOK_DELIVERY_HEADER]).toBe(id);
      expect(await prisma.workflowStepExecution.count({where: {executionId, stepId: webhook.id}})).toBe(1);
      expect((await stepOf(executionId, after.id)).status).toBe(StepExecutionStatus.COMPLETED);
      expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('makes one attempt: a failure that may pass fails again instead of scheduling more', async () => {
      const {workflow, webhook, executionId} = await failedRun();
      await WorkflowService.retryExecution(projectId, workflow.id, executionId);
      fetchMock.mockImplementation(answer(503));

      await expect(resume(executionId, webhook.id)).rejects.toThrow('Webhook responded with HTTP 503');

      expect(QueueService.queueWebhookRetry).not.toHaveBeenCalled();
      expect((await runOf(executionId)).status).toBe(WorkflowExecutionStatus.FAILED);
      expect((await stepOf(executionId, webhook.id)).error).toBe('Webhook responded with HTTP 503');
    });

    it('lets only one of two retries through', async () => {
      const {workflow, executionId} = await failedRun();

      const results = await Promise.allSettled([
        WorkflowService.retryExecution(projectId, workflow.id, executionId),
        WorkflowService.retryExecution(projectId, workflow.id, executionId),
      ]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(QueueService.queueRetriedRun).toHaveBeenCalledTimes(1);
    });

    it('creates the step if the run failed before reaching it, with one attempt too', async () => {
      const {workflow, webhook, executionId} = await setup();
      await prisma.workflowExecution.update({
        where: {id: executionId},
        data: {status: WorkflowExecutionStatus.FAILED, currentStepId: webhook.id},
      });

      await WorkflowService.retryExecution(projectId, workflow.id, executionId);

      expect(await stepOf(executionId, webhook.id)).toMatchObject({
        status: StepExecutionStatus.PENDING,
        output: {webhookManual: true},
      });
    });

    it('resets a step left scheduled, so that it keeps its ID and gets one attempt', async () => {
      const {workflow, webhook, executionId} = await failedRun();
      const {id} = await stepOf(executionId, webhook.id);
      await prisma.workflowStepExecution.update({
        where: {id},
        data: {status: StepExecutionStatus.SCHEDULED, output: {webhookAttempts: 2}},
      });

      await WorkflowService.retryExecution(projectId, workflow.id, executionId);

      expect(await stepOf(executionId, webhook.id)).toMatchObject({
        id,
        status: StepExecutionStatus.PENDING,
        output: {webhookManual: true},
      });
    });

    it('does not send an email again', async () => {
      const workflow = await factories.createWorkflow({projectId, enabled: true});
      const template = await factories.createTemplate({projectId});
      const step = await factories.createWorkflowStep({
        workflowId: workflow.id,
        type: WorkflowStepType.SEND_EMAIL,
        templateId: template.id,
      });
      const execution = await prisma.workflowExecution.create({
        data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.FAILED, currentStepId: step.id},
      });
      const stepExecution = await prisma.workflowStepExecution.create({
        data: {executionId: execution.id, stepId: step.id, status: StepExecutionStatus.FAILED, error: 'Interrupted'},
      });
      await prisma.email.create({
        data: {
          projectId,
          contactId,
          subject: 's',
          body: 'b',
          from: 'a@example.com',
          sourceType: 'WORKFLOW',
          workflowExecutionId: execution.id,
          workflowStepExecutionId: stepExecution.id,
        },
      });

      await WorkflowService.retryExecution(projectId, workflow.id, execution.id);
      await resume(execution.id, step.id);

      expect(await prisma.email.count({where: {workflowExecutionId: execution.id}})).toBe(1);
      expect((await runOf(execution.id)).status).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    describe('refuses', () => {
      const refused = (workflowId: string, executionId: string) =>
        WorkflowService.retryExecution(projectId, workflowId, executionId);

      it('an execution of another project', async () => {
        const {workflow, executionId} = await failedRun();
        const {project} = await factories.createUserWithProject();

        await expect(WorkflowService.retryExecution(project.id, workflow.id, executionId)).rejects.toMatchObject({
          code: 404,
        });
      });

      it('an execution that did not fail', async () => {
        const {workflow, executionId} = await setup();

        await expect(refused(workflow.id, executionId)).rejects.toMatchObject({code: 409});
      });

      it('a run whose step was deleted', async () => {
        const {workflow, executionId} = await failedRun();
        await prisma.workflowExecution.update({where: {id: executionId}, data: {currentStepId: null}});

        await expect(refused(workflow.id, executionId)).rejects.toMatchObject({code: 409});
      });

      it.each([WorkflowStepType.UPDATE_CONTACT, WorkflowStepType.DELAY, WorkflowStepType.WAIT_FOR_EVENT])(
        'a run stopped on a %s step',
        async type => {
          const workflow = await factories.createWorkflow({projectId, enabled: true});
          const step = await factories.createWorkflowStep({workflowId: workflow.id, type, config: {}});
          const execution = await prisma.workflowExecution.create({
            data: {workflowId: workflow.id, contactId, status: WorkflowExecutionStatus.FAILED, currentStepId: step.id},
          });

          await expect(refused(workflow.id, execution.id)).rejects.toMatchObject({code: 409});
          expect((await runOf(execution.id)).status).toBe(WorkflowExecutionStatus.FAILED);
        },
      );

      it('a workflow that is off, and a disabled project', async () => {
        const {workflow, executionId} = await failedRun();
        await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: false}});
        await expect(refused(workflow.id, executionId)).rejects.toMatchObject({code: 409});

        await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: true}});
        await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
        await expect(refused(workflow.id, executionId)).rejects.toMatchObject({code: 409});
      });
    });
  });

  describe('listExecutions', () => {
    it('says what went wrong in a failed run, and when a webhook tries again', async () => {
      fetchMock.mockImplementation(answer(503));
      const {workflow, trigger, executionId} = await setup();
      await WorkflowExecutionService.processStepExecution(executionId, trigger.id);

      const {executions} = await WorkflowService.listExecutions(projectId, workflow.id);

      expect(executions[0]!.stepExecutions).toEqual([
        {
          error: 'Webhook responded with HTTP 503',
          status: StepExecutionStatus.SCHEDULED,
          executeAfter: expect.any(Date),
        },
      ]);
    });
  });
});
