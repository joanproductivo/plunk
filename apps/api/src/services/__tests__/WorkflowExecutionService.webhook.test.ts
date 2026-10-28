import {createHmac} from 'node:crypto';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StepExecutionStatus, WorkflowExecutionStatus, WorkflowStepType, WorkflowTriggerType} from '@plunk/db';
import {WebhookSigningSecrets} from '../WebhookSigningSecrets';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Tests for WEBHOOK step config templating.
 *
 * `executeWebhook` is a private static method but is invokable at runtime
 * through a `as any` cast. We mock `safeFetch` (also private) via the
 * same mechanism so we can capture the rendered request without making a
 * real network call.
 */
describe('WorkflowExecutionService.executeWebhook templating', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  // Capture (url, options) passed to safeFetch
  let safeFetchSpy: ReturnType<typeof vi.spyOn>;
  let captured: {url: string; options: RequestInit} | null = null;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;

    captured = null;
    safeFetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(WorkflowExecutionService as any, 'safeFetch')
      .mockImplementation(async (...args: unknown[]) => {
        const [url, options] = args as [string, RequestInit];
        captured = {url, options};
        return new Response('{"ok":true}', {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        });
      });
  });

  afterEach(() => {
    safeFetchSpy.mockRestore();
  });

  /**
   * Helper: build a workflow with a single WEBHOOK step using the given
   * config, plus a contact and a RUNNING execution. Returns the args
   * shape `executeWebhook` expects.
   */
  async function setup(
    webhookConfig: Record<string, unknown>,
    contactOverrides: {data?: Record<string, unknown>} = {},
    executionContext: Record<string, unknown> = {},
  ) {
    const contact = await factories.createContact({
      projectId,
      data: contactOverrides.data,
    });

    const workflow = await factories.createWorkflow({
      projectId,
      enabled: true,
      triggerType: WorkflowTriggerType.EVENT,
      triggerConfig: {eventName: 'test.event'},
    });

    const step = await prisma.workflowStep.create({
      data: {
        workflowId: workflow.id,
        type: WorkflowStepType.WEBHOOK,
        name: 'Webhook',
        position: {x: 0, y: 0},
        config: webhookConfig,
      },
    });

    const execution = await prisma.workflowExecution.create({
      data: {
        workflowId: workflow.id,
        contactId: contact.id,
        status: WorkflowExecutionStatus.RUNNING,
        context: executionContext,
      },
      include: {contact: true, workflow: true},
    });

    const stepExecution = await prisma.workflowStepExecution.create({
      data: {
        executionId: execution.id,
        stepId: step.id,
        status: StepExecutionStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    return {step, execution, stepExecution};
  }

  async function invokeWebhook(
    step: unknown,
    execution: unknown,
    stepExecution: unknown,
    config: unknown,
  ) {
    // Call through `as any` because executeWebhook is private at the
    // TypeScript level. JS has no actual access control.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (WorkflowExecutionService as any).executeWebhook(step, execution, stepExecution, config);
  }

  it('stores at most 64 KB of the response, marked as truncated (Plunk Lite)', async () => {
    safeFetchSpy.mockImplementation(async () => new Response('x'.repeat(1024 * 1024), {status: 200}));
    const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'GET'});

    const result = await invokeWebhook(step, execution, stepExecution, step.config);

    expect(result.truncated).toBe(true);
    expect((result.response as string).length).toBe(64 * 1024);
  });

  it('parses a small JSON response as before, without a truncated mark (Plunk Lite)', async () => {
    const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'GET'});

    const result = await invokeWebhook(step, execution, stepExecution, step.config);

    expect(result.response).toEqual({ok: true});
    expect(result).not.toHaveProperty('truncated');
  });

  it('renders {{vars}} in the URL from contact.data', async () => {
    const {step, execution, stepExecution} = await setup(
      {
        url: 'https://example.com/api/users/{{userId}}',
        method: 'GET',
      },
      {data: {userId: 'abc-123'}},
    );

    await invokeWebhook(step, execution, stepExecution, step.config);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://example.com/api/users/abc-123');
  });

  it('renders {{vars}} in header values', async () => {
    const {step, execution, stepExecution} = await setup(
      {
        url: 'https://example.com/hook',
        method: 'POST',
        headers: {
          Authorization: 'Bearer {{apiToken}}',
          'X-Static': 'literal',
        },
      },
      {data: {apiToken: 'secret-token-xyz'}},
    );

    await invokeWebhook(step, execution, stepExecution, step.config);

    expect(captured).not.toBeNull();
    const headers = captured!.options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token-xyz');
    expect(headers['X-Static']).toBe('literal');
  });

  it('renders {{vars}} in nested object body leaves and JSON-encodes', async () => {
    const {step, execution, stepExecution} = await setup(
      {
        url: 'https://example.com/hook',
        method: 'POST',
        body: {
          user: {
            email: '{{email}}',
            name: '{{firstName}}',
          },
          ref: 'literal-ref',
          tags: ['plan:{{plan}}', 'static'],
        },
      },
      {data: {firstName: 'Ada', plan: 'gold'}},
      {campaignId: 'camp-9'},
    );

    await invokeWebhook(step, execution, stepExecution, step.config);

    expect(captured).not.toBeNull();
    const body = JSON.parse(captured!.options.body as string);
    expect(body.user.email).toBe(execution.contact.email);
    expect(body.user.name).toBe('Ada');
    expect(body.ref).toBe('literal-ref');
    expect(body.tags).toEqual(['plan:gold', 'static']);
  });

  it('leaves non-string body leaves untouched', async () => {
    const {step, execution, stepExecution} = await setup({
      url: 'https://example.com/hook',
      method: 'POST',
      body: {
        score: 42,
        active: true,
        deleted: null,
        meta: {
          count: 7,
          enabled: false,
        },
        tags: ['{{plan ?? free}}', 100, false],
      },
    });

    await invokeWebhook(step, execution, stepExecution, step.config);

    expect(captured).not.toBeNull();
    const body = JSON.parse(captured!.options.body as string);
    expect(body.score).toBe(42);
    expect(body.active).toBe(true);
    expect(body.deleted).toBe(null);
    expect(body.meta).toEqual({count: 7, enabled: false});
    // String leaf rendered (with default), non-string leaves preserved.
    expect(body.tags).toEqual(['free', 100, false]);
  });

  it('renders {{event.*}} variables from the trigger payload', async () => {
    const {step, execution, stepExecution} = await setup(
      {
        url: 'https://example.com/hooks/{{event.referrer}}',
        method: 'POST',
        headers: {
          'X-Email-Id': '{{event.emailId}}',
        },
        body: {
          referrer: '{{event.referrer}}',
          subject: '{{event.subject}}',
        },
      },
      {},
      {referrer: 'newsletter-may', emailId: 'eml_abc123', subject: 'Welcome'},
    );

    await invokeWebhook(step, execution, stepExecution, step.config);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://example.com/hooks/newsletter-may');
    const headers = captured!.options.headers as Record<string, string>;
    expect(headers['X-Email-Id']).toBe('eml_abc123');
    const body = JSON.parse(captured!.options.body as string);
    expect(body.referrer).toBe('newsletter-may');
    expect(body.subject).toBe('Welcome');
  });

  describe('signature and failures (Plunk Lite)', () => {
    /** The X-Plunk-Signature of the captured request, recomputed from its own `t` and body */
    function signatureOf(headers: Record<string, string>) {
      const header = headers['X-Plunk-Signature'];
      const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
      return match ? {t: Number(match[1]), v1: match[2]} : null;
    }

    it('signs the body as sent with the step secret', async () => {
      const {step, execution, stepExecution} = await setup({
        url: 'https://example.com/hook',
        method: 'POST',
        body: {email: '{{email}}', note: 'ñandú 🌴'},
      });
      await prisma.plunkLiteWebhookSecret.create({
        data: {stepId: step.id, workflowId: step.workflowId, projectId, secret: 's'.repeat(40)},
      });

      await invokeWebhook(step, execution, stepExecution, step.config);

      const headers = captured!.options.headers as Record<string, string>;
      const signature = signatureOf(headers);
      expect(signature).not.toBeNull();
      expect(Math.abs(signature!.t - Date.now() / 1000)).toBeLessThan(5);
      expect(signature!.v1).toBe(
        createHmac('sha256', 's'.repeat(40))
          .update(`${signature!.t}.${captured!.options.body as string}`, 'utf8')
          .digest('hex'),
      );
    });

    it('signs "<t>." for a GET, which sends no body', async () => {
      const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'GET'});
      await prisma.plunkLiteWebhookSecret.create({
        data: {stepId: step.id, workflowId: step.workflowId, projectId, secret: 'g'.repeat(32)},
      });

      await invokeWebhook(step, execution, stepExecution, step.config);

      const signature = signatureOf(captured!.options.headers as Record<string, string>);
      expect(captured!.options.body).toBeUndefined();
      expect(signature!.v1).toBe(createHmac('sha256', 'g'.repeat(32)).update(`${signature!.t}.`).digest('hex'));
    });

    it('sends no signature without a secret, and never a step header standing in for it', async () => {
      const {step, execution, stepExecution} = await setup({
        url: 'https://example.com/hook',
        method: 'POST',
        headers: {'x-plunk-signature': 't=1,v1=forged', 'X-Other': 'kept'},
      });

      await invokeWebhook(step, execution, stepExecution, step.config);

      const headers = captured!.options.headers as Record<string, string>;
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('x-plunk-signature');
      expect(headers['X-Other']).toBe('kept');
    });

    it('replaces a step header named like the signature when the step signs', async () => {
      const {step, execution, stepExecution} = await setup({
        url: 'https://example.com/hook',
        method: 'POST',
        headers: {'x-plunk-signature': 't=1,v1=forged'},
      });
      await prisma.plunkLiteWebhookSecret.create({
        data: {stepId: step.id, workflowId: step.workflowId, projectId, secret: 'k'.repeat(32)},
      });

      await invokeWebhook(step, execution, stepExecution, step.config);

      const headers = captured!.options.headers as Record<string, string>;
      expect(Object.keys(headers).filter(key => key.toLowerCase() === 'x-plunk-signature')).toEqual([
        'X-Plunk-Signature',
      ]);
      expect(signatureOf(headers)).not.toBeNull();
    });

    it('sends nothing when the secret cannot be read, rather than an unsigned request', async () => {
      const read = vi.spyOn(WebhookSigningSecrets, 'forStep').mockRejectedValue(new Error('database down'));
      const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'POST'});

      await expect(invokeWebhook(step, execution, stepExecution, step.config)).rejects.toThrow('database down');
      expect(safeFetchSpy).not.toHaveBeenCalled();
      read.mockRestore();
    });

    it('fails the step on an answer that is not a 2xx, without its body', async () => {
      safeFetchSpy.mockImplementation(async () => new Response('{"error":"bad signature"}', {status: 401}));
      const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'POST'});

      await expect(invokeWebhook(step, execution, stepExecution, step.config)).rejects.toThrow(
        /^Webhook responded with HTTP 401$/,
      );
    });

    it('still completes on a 2xx', async () => {
      safeFetchSpy.mockImplementation(async () => new Response(null, {status: 204}));
      const {step, execution, stepExecution} = await setup({url: 'https://example.com/hook', method: 'POST'});

      const result = await invokeWebhook(step, execution, stepExecution, step.config);

      expect(result).toMatchObject({statusCode: 204, success: true});
    });
  });
});
