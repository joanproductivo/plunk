/**
 * Plunk Lite: run a controller handler in a test, without a server: a Response stand-in that records
 * the answer, and a runner that resolves with it -- or with the error passed to `next`.
 */
import {EventEmitter} from 'node:events';

import type {NextFunction, Request, Response} from 'express';

/** What a handler answered, or the error it passed on (its status, if it is an HttpException) */
export interface HandlerOutcome<TBody = Record<string, unknown>> {
  status: number;
  body?: TBody;
  error?: unknown;
}

/** A Response stand-in with these locals (`auth`, for one) */
export function createResponse(locals: Record<string, unknown> = {}) {
  const res = new EventEmitter() as unknown as Response & {statusCode: number};
  res.locals = locals;
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  return res;
}

/** Run a handler (behind `middleware`, if given) until it answers */
export function runHandler<TBody = Record<string, unknown>>(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
  res: Response & {statusCode: number},
  middleware?: (req: Request, res: Response, next: NextFunction) => unknown,
): Promise<HandlerOutcome<TBody>> {
  return new Promise<HandlerOutcome<TBody>>(resolve => {
    const failed = (error?: unknown) => {
      const code = (error as {code?: unknown} | undefined)?.code;
      resolve({status: typeof code === 'number' ? code : 500, error});
    };
    res.json = ((json: TBody) => {
      resolve({status: res.statusCode, body: json});
      return res;
    }) as Response['json'];
    const go = () => void handler(req, res, failed);
    if (middleware) {
      void middleware(req, res, (error?: unknown) => (error ? failed(error) : go()));
    } else {
      go();
    }
  });
}
