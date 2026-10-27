import {randomUUID} from 'node:crypto';

import cookies from 'cookie-parser';
import express, {type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {DASHBOARD_URI} from '../../app/constants.js';
import {ErrorCode, HttpException} from '../../exceptions/index.js';
import {isAuthenticated, jwt, parseJwt, requireAuth} from '../auth.js';

/**
 * The dashboard session cookie is sent on requests from any site, so the API only trusts it on a
 * request that changes something when the browser says the request comes from an allowed origin.
 */

const OTHER_SITE = 'https://attacker.example';

function fakeRequest(method: string, headers: Record<string, string>, token?: string): Request {
  return {method, headers, cookies: token ? {next_token: token} : {}} as unknown as Request;
}

/** What a middleware passes to next(): an error, or undefined */
function runMiddleware(middleware: typeof requireAuth, req: Request): Promise<unknown> {
  return new Promise(resolve => {
    void middleware(req, {locals: {}} as Response, resolve as NextFunction);
  });
}

const forbidden = expect.objectContaining({code: 403, errorCode: ErrorCode.FORBIDDEN});

describe('parseJwt origin check', () => {
  const userId = randomUUID();
  const token = jwt.sign(userId);

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('turns away %s from another site', method => {
    expect(() => parseJwt(fakeRequest(method, {origin: OTHER_SITE}, token))).toThrow(forbidden);
  });

  it('turns away the opaque origin a sandboxed page or a no-referrer form sends', () => {
    expect(() => parseJwt(fakeRequest('POST', {origin: 'null'}, token))).toThrow(forbidden);
  });

  it('turns away an empty Origin', () => {
    expect(() => parseJwt(fakeRequest('POST', {origin: ''}, token))).toThrow(forbidden);
  });

  it('checks the origin before the cookie, so a request from another site never reads it', () => {
    expect(() => parseJwt(fakeRequest('POST', {origin: OTHER_SITE}))).toThrow(forbidden);
  });

  it('accepts a request from the dashboard', () => {
    expect(parseJwt(fakeRequest('POST', {origin: DASHBOARD_URI}, token))).toBe(userId);
  });

  it('accepts a request without an Origin, as clients outside the browser send', () => {
    expect(parseJwt(fakeRequest('POST', {}, token))).toBe(userId);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not check %s, which changes nothing', method => {
    expect(parseJwt(fakeRequest(method, {origin: OTHER_SITE}, token))).toBe(userId);
  });

  it('turns away a dashboard request from another site in requireAuth before looking up the project', async () => {
    const req = fakeRequest('POST', {'origin': OTHER_SITE, 'x-project-id': randomUUID()}, token);

    // FORBIDDEN, not the PROJECT_ACCESS_DENIED the membership lookup would answer for a stranger's project
    expect(await runMiddleware(requireAuth, req)).toEqual(forbidden);
  });

  it('leaves API keys alone: requireAuth answers a key from any origin without the cookie check', async () => {
    const req = fakeRequest('POST', {origin: OTHER_SITE, authorization: 'Bearer sk_not_a_real_key'});

    expect(await runMiddleware(requireAuth, req)).toEqual(
      expect.objectContaining({code: 401, errorCode: ErrorCode.INVALID_API_KEY}),
    );
  });
});

describe('cookie routes over HTTP', () => {
  // A route guarded like the account routes, behind the parsers the API uses
  const app = express();
  app.use(express.json());
  app.use(cookies());
  app.post('/session-route', isAuthenticated, (_req: Request, res: Response) => {
    res.json({userId: res.locals.auth.userId});
  });
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof HttpException ? error.code : 500).json({message: error.message});
  });

  const userId = randomUUID();
  const cookie = `next_token=${jwt.sign(userId)}`;

  /** What a form on another page posts: urlencoded, with the cookie the browser attaches */
  const formPost = () => request(app).post('/session-route').set('Cookie', cookie).type('form').send('a=1');

  it('turns away a form posted from another site', async () => {
    expect((await formPost().set('Origin', OTHER_SITE)).status).toBe(403);
  });

  it('turns away a form posted from an opaque origin', async () => {
    expect((await formPost().set('Origin', 'null')).status).toBe(403);
  });

  it('accepts the dashboard', async () => {
    const res = await formPost().set('Origin', DASHBOARD_URI);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
  });

  it('accepts a request without an Origin', async () => {
    expect((await formPost()).status).toBe(200);
  });
});
