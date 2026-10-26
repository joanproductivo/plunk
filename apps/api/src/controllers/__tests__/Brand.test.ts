import type {Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {HttpException} from '../../exceptions/index.js';
import {BrandService} from '../../services/BrandService.js';
import {MembershipService} from '../../services/MembershipService.js';
import {Brand} from '../Brand.js';

vi.mock('../../services/BrandService.js', () => ({
  BrandService: {get: vi.fn(async () => ({textColor: '#374151'})), save: vi.fn(async () => ({textColor: '#111111'}))},
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
async function call(handler: 'getBrand' | 'saveBrand', auth: Record<string, unknown>, body?: unknown) {
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
    new Brand()[handler]({params: {id: PROJECT}, body} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, json, error};
}

describe('/projects/:id/brand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gives members the project's brand", async () => {
    const {status, json} = await call('getBrand', SESSION);

    expect(status).toBe(200);
    expect(json).toEqual({textColor: '#374151'});
    expect(MembershipService.requireAccess).toHaveBeenCalledWith('user-1', PROJECT);
  });

  it('lets only admins save it', async () => {
    const {status, json} = await call('saveBrand', SESSION, {textColor: '#111111'});

    expect(status).toBe(200);
    expect(json).toEqual({textColor: '#111111'});
    expect(MembershipService.requireAdminAccess).toHaveBeenCalledWith('user-1', PROJECT);
    expect(BrandService.save).toHaveBeenCalledWith(PROJECT, {textColor: '#111111'});
  });

  it('refuses API keys either way: the brand is only for the dashboard', async () => {
    for (const handler of ['getBrand', 'saveBrand'] as const) {
      const {error} = await call(handler, {type: 'apiKey', projectId: PROJECT}, {});

      expect((error as HttpException).code).toBe(403);
    }
    expect(BrandService.get).not.toHaveBeenCalled();
    expect(BrandService.save).not.toHaveBeenCalled();
  });

  it('refuses a body that is not an object', async () => {
    for (const body of [undefined, 'x', ['#fff']]) {
      const {error} = await call('saveBrand', SESSION, body);

      expect((error as HttpException).code).toBe(400);
    }
    expect(BrandService.save).not.toHaveBeenCalled();
  });

  it('does not save when the member is not an admin', async () => {
    vi.mocked(MembershipService.requireAdminAccess).mockRejectedValueOnce(new HttpException(403, 'Admin only'));

    const {error} = await call('saveBrand', SESSION, {textColor: '#111111'});

    expect((error as HttpException).code).toBe(403);
    expect(BrandService.save).not.toHaveBeenCalled();
  });
});
