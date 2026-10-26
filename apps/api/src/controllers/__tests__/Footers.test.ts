import type {Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {HttpException} from '../../exceptions/index.js';
import {MembershipService} from '../../services/MembershipService.js';
import {ProjectFooterService} from '../../services/ProjectFooterService.js';
import {Footers} from '../Footers.js';

vi.mock('../../services/ProjectFooterService.js', () => ({
  ProjectFooterService: {get: vi.fn(async () => ({})), save: vi.fn(async (_id: string, footers: unknown) => footers)},
}));
vi.mock('../../services/MembershipService.js', () => ({
  MembershipService: {requireAccess: vi.fn(async () => ({})), requireAdminAccess: vi.fn(async () => ({}))},
}));

const PROJECT = '3f1c2a8e-7b4d-4c3a-9e2f-1a2b3c4d5e6f';
const SESSION = {type: 'jwt', userId: 'user-1', projectId: PROJECT};

/**
 * Calls a handler as Express would. `CatchAsync` does not return its promise, so the outcome is
 * awaited from whichever of the response or `next` it reaches first.
 */
async function call(handler: 'getFooters' | 'saveFooters', auth: Record<string, unknown>, body?: unknown) {
  let status = 200;
  let json: unknown;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth},
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        json = value;
        resolve();
        return this;
      },
    } as unknown as Response;
    new Footers()[handler]({params: {id: PROJECT}, body} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, json, error};
}

describe('/projects/:id/footers', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gives members the project's own footers", async () => {
    const {status, json} = await call('getFooters', SESSION);

    expect(status).toBe(200);
    expect(json).toEqual({});
    expect(MembershipService.requireAccess).toHaveBeenCalledWith('user-1', PROJECT);
  });

  it('lets admins save valid footers, trimmed', async () => {
    const {status, json} = await call('saveFooters', SESSION, {es: {text: ' Hola ', linkText: 'darte de baja'}});

    expect(status).toBe(200);
    expect(json).toEqual({es: {text: 'Hola', linkText: 'darte de baja'}});
    expect(MembershipService.requireAdminAccess).toHaveBeenCalledWith('user-1', PROJECT);
  });

  it('refuses invalid footers with the reasons, saving nothing', async () => {
    const {error} = await call('saveFooters', SESSION, {
      es: {text: 'Hola', linkText: '.'},
      xx: {text: 'x', linkText: 'leave'},
    });

    expect((error as HttpException).code).toBe(400);
    expect((error as HttpException).message).toContain('es: the link text needs 3 to 100 characters');
    expect((error as HttpException).message).toContain('xx: not a supported language');
    expect(ProjectFooterService.save).not.toHaveBeenCalled();
  });

  it('refuses a body that is not an object, and API keys', async () => {
    for (const body of [undefined, 'x', ['es']]) {
      expect(((await call('saveFooters', SESSION, body)).error as HttpException).code).toBe(400);
    }
    for (const handler of ['getFooters', 'saveFooters'] as const) {
      expect(((await call(handler, {type: 'apiKey', projectId: PROJECT}, {})).error as HttpException).code).toBe(403);
    }
    expect(ProjectFooterService.save).not.toHaveBeenCalled();
  });
});
