import type {NextFunction, Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {ErrorCode} from '../../exceptions/index.js';

/** Plunk Lite: a server can switch off the public key /v1/track takes (PLUNK_LITE_PUBLIC_TRACK) */
describe('requirePublicKey with PLUNK_LITE_PUBLIC_TRACK', () => {
  afterEach(() => {
    delete process.env.PLUNK_LITE_PUBLIC_TRACK;
    vi.resetModules();
  });

  async function run(setting: string | undefined, authorization: string | null = 'Bearer pk_short'): Promise<unknown> {
    if (setting === undefined) {
      delete process.env.PLUNK_LITE_PUBLIC_TRACK;
    } else {
      process.env.PLUNK_LITE_PUBLIC_TRACK = setting;
    }
    vi.resetModules();
    const {requirePublicKey} = await import('../auth.js');
    const req = {method: 'POST', headers: authorization ? {authorization} : {}} as unknown as Request;
    return new Promise(resolve => {
      void requirePublicKey(req, {locals: {}} as Response, resolve as NextFunction);
    });
  }

  it.each(['off', 'false', 'OFF'])('answers 403 with %s', async setting => {
    expect(await run(setting)).toEqual(expect.objectContaining({code: 403, errorCode: ErrorCode.FORBIDDEN}));
  });

  it("answers a request without a key 401, not the switch's 403", async () => {
    expect(await run('off', null)).toEqual(expect.objectContaining({code: 401, errorCode: ErrorCode.MISSING_AUTH}));
  });

  it('takes the key by default', async () => {
    // Past the switch, the made-up key is refused for its shape
    expect(await run(undefined)).toEqual(expect.objectContaining({code: 401, errorCode: ErrorCode.INVALID_API_KEY}));
  });
});
