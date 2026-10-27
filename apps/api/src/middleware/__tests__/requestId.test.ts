import type {NextFunction, Request, Response} from 'express';
import {describe, expect, it, vi} from 'vitest';

import {requestIdMiddleware} from '../requestId.js';

/** Plunk Lite: the request id is the primary key of api_requests, so a client's own must be a UUID */
describe('requestIdMiddleware', () => {
  function idFor(header?: string): string {
    const req = {headers: header === undefined ? {} : {'x-request-id': header}} as unknown as Request;
    const res = {locals: {}, setHeader: vi.fn()} as unknown as Response;
    requestIdMiddleware(req, res, vi.fn() as NextFunction);
    return res.locals.requestId as string;
  }

  it("keeps a client's UUID", () => {
    const id = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
    expect(idFor(id)).toBe(id);
  });

  it.each(['x', 'a'.repeat(300), '-'.repeat(36)])('replaces %s with a new UUID', header => {
    const id = idFor(header);
    expect(id).not.toBe(header);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
