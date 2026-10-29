import type {Request, Response} from 'express';
import {describe, expect, it} from 'vitest';

import {CatchAsync} from '../asyncHandler';
import {invokeHandler} from '../invokeHandler';

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** A handler wrapped as `@CatchAsync` wraps a controller's method */
function catchAsync(method: Handler) {
  const descriptor: PropertyDescriptor = {value: method};
  CatchAsync({}, 'method', descriptor);
  return descriptor.value as Handler;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 10));

/**
 * Calling a `CatchAsync` handler outside a request: its answer is what it sends, its errors reach
 * `next`, and it is given up on if it never answers
 */
describe('invokeHandler', () => {
  it('waits for the answer of a handler that does not return its promise', async () => {
    const handler = catchAsync(async (req, res) => {
      await pause();
      return res.status(202).json({got: req.body, extra: (req as unknown as {flag?: boolean}).flag});
    });

    const answer = await invokeHandler(handler, {a: 1}, {extra: {flag: true}});

    expect(answer).toEqual({status: 202, body: {got: {a: 1}, extra: true}});
  });

  it('rejects with what the handler throws', async () => {
    const handler = catchAsync(async () => {
      await pause();
      throw new Error('boom');
    });

    await expect(invokeHandler(handler, {})).rejects.toThrow('boom');
  });

  it('gives up on a handler that never answers', async () => {
    const handler = catchAsync(() => new Promise(() => undefined));

    await expect(invokeHandler(handler, {}, {timeoutMs: 50})).rejects.toThrow('did not answer');
  });
});
