import type {Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {WebhookSigningSecrets} from '../../services/WebhookSigningSecrets.js';
import {Workflows} from '../Workflows.js';

vi.mock('../../services/WebhookSigningSecrets.js', () => ({
  WebhookSigningSecrets: {
    status: vi.fn(async () => ({active: true, updatedAt: '2026-10-28T10:00:00.000Z'})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}));

const PROJECT = '3f1c2a8e-7b4d-4c3a-9e2f-1a2b3c4d5e6f';
const AUTH = {type: 'secret', projectId: PROJECT};
const PARAMS = {id: 'workflow-1', stepId: 'step-1'};

type Handler = 'getSigningSecret' | 'setSigningSecret' | 'removeSigningSecret';

/**
 * Calls a handler as Express would. `CatchAsync` does not return its promise, so the outcome is
 * awaited from whichever of the response or `next` it reaches first.
 */
async function call(handler: Handler, body?: unknown) {
  let status = 200;
  let json: unknown;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth: AUTH},
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        json = value;
        resolve();
        return this;
      },
      send() {
        resolve();
        return this;
      },
    } as unknown as Response;
    new Workflows()[handler]({params: PARAMS, body} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, json, error};
}

/** Plunk Lite: the signing secret of a webhook step is write-only */
describe('/workflows/:id/steps/:stepId/signing-secret', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports whether the step signs, and nothing else', async () => {
    const {status, json} = await call('getSigningSecret');

    expect(status).toBe(200);
    expect(json).toEqual({active: true, updatedAt: '2026-10-28T10:00:00.000Z'});
    expect(WebhookSigningSecrets.status).toHaveBeenCalledWith(PROJECT, 'workflow-1', 'step-1');
  });

  it('sets a secret and answers 204 with no body', async () => {
    const secret = 'Zx9_-'.repeat(8);
    const {status, json, error} = await call('setSigningSecret', {secret});

    expect(error).toBeUndefined();
    expect(status).toBe(204);
    expect(json).toBeUndefined();
    expect(WebhookSigningSecrets.set).toHaveBeenCalledWith(PROJECT, 'workflow-1', 'step-1', secret);
  });

  it.each([
    ['short', 'x'.repeat(31)],
    ['long', 'x'.repeat(257)],
    ['with a space', `${'x'.repeat(32)} y`],
    ['not ASCII', `${'x'.repeat(32)}ñ`],
  ])('refuses a %s secret without repeating it', async (_case, secret) => {
    const {error} = await call('setSigningSecret', {secret});

    expect(error).toBeInstanceOf(ZodError);
    expect(JSON.stringify((error as ZodError).issues)).not.toContain(secret);
    expect(WebhookSigningSecrets.set).not.toHaveBeenCalled();
  });

  it('removes the secret and answers 204', async () => {
    const {status} = await call('removeSigningSecret');

    expect(status).toBe(204);
    expect(WebhookSigningSecrets.remove).toHaveBeenCalledWith(PROJECT, 'workflow-1', 'step-1');
  });
});
