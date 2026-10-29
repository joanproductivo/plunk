import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';

/** What a handler answered: the status it set and the body it sent */
interface HandlerAnswer<TBody = unknown> {
  status: number;
  body: TBody;
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** What invokeHandler rejects with when the handler never answers: it may still be running */
export class HandlerTimedOut extends Error {}

/**
 * Plunk Lite: call an Express handler outside a request, as the worker does with the SNS webhook,
 * and wait for its answer. A handler decorated with `CatchAsync` does not return the promise it
 * creates, so awaiting the call itself resolves before any of its work has run: the answer is the
 * `res.json` it ends with. What it throws or passes to `next` rejects, instead of escaping as an
 * unhandled rejection, and a handler that never answers is given up on after `timeoutMs`.
 *
 * Without a `res`, the response is a stand-in with only `status`, `json` and `statusCode`; without
 * a `req`, the request carries `body` and `extra`.
 */
export function invokeHandler<TBody = unknown>(
  handler: Handler,
  body: unknown,
  {
    req,
    res,
    extra = {},
    timeoutMs = 60_000,
  }: {req?: Request; res?: Response; extra?: Record<string, unknown>; timeoutMs?: number} = {},
): Promise<HandlerAnswer<TBody>> {
  return new Promise<HandlerAnswer<TBody>>((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(
      () => settle(() => reject(new HandlerTimedOut(`Handler did not answer within ${timeoutMs} ms`))),
      timeoutMs,
    );
    function settle(finish: () => void) {
      clearTimeout(timer);
      answered = true;
      finish();
    }

    const response = res ?? ({statusCode: 200} as unknown as Response);
    response.status ??= (code: number) => {
      response.statusCode = code;
      return response;
    };
    response.json = ((sent: TBody) => {
      if (!answered) {
        settle(() => resolve({status: response.statusCode, body: sent}));
      }
      return response;
    }) as Response['json'];
    const request = req ?? ({body, get: () => undefined, headers: {}, ...extra} as unknown as Request);

    const next = (error?: unknown) => {
      if (answered) {
        // Already answered, or given up on: nothing waits for it, so it is only logged
        if (error) signale.warn('[HANDLER] Error after the handler answered:', error);
        return;
      }
      settle(() => reject(error ?? new Error('Handler passed control on')));
    };
    try {
      Promise.resolve(handler(request, response, next)).catch(next);
    } catch (error) {
      next(error);
    }
  });
}
