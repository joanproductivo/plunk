import type {Application, NextFunction, Request, Response} from 'express';
import {json} from 'express';

import {HttpException} from '../exceptions/index.js';

/** Bodies above this are what only /v1/send accepts, and what its in-flight cap counts */
const SMALL_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Large /v1/send bodies read at once. Each is held in memory several times over while it is
 * parsed and while its key is checked, so a burst of them -- with or without a valid key -- could
 * otherwise fill the api's heap. Legitimate sends with large attachments are rare and short.
 */
const MAX_LARGE_SENDS_IN_FLIGHT = 8;

let largeSendsInFlight = 0;

/**
 * Turn away a large /v1/send body, before reading it, while too many are already being handled
 */
function capLargeSends(req: Request, res: Response, next: NextFunction): void {
  const length = Number(req.get('content-length'));

  // A body without a declared length may be any size, so it counts as large
  if (Number.isFinite(length) && length <= SMALL_BODY_BYTES) {
    return next();
  }

  if (largeSendsInFlight >= MAX_LARGE_SENDS_IN_FLIGHT) {
    res.set('Retry-After', '5');
    return next(new HttpException(503, 'Too many large sends in progress. Please retry shortly.'));
  }

  largeSendsInFlight++;
  res.once('close', () => {
    largeSendsInFlight--;
  });
  next();
}

/**
 * Parse JSON bodies. Bodies are parsed before any route checks who is asking, so the limit
 * applies to anonymous requests too: only /v1/send, whose attachments travel in the body, gets
 * as much as nginx lets through in front of it (client_max_body_size 10M), and only a few such
 * bodies at a time. Every other body is small -- the largest, lists of up to 10,000 ids -- and
 * 2 MB keeps unauthenticated requests from filling the heap; /v1/track, whose key is public, gets
 * 64 KB. A body over its limit fails with `type: 'entity.too.large'`.
 */
export function useJsonBodyParsers(app: Application): void {
  app.use('/v1/send', capLargeSends, json({limit: '10mb'}));
  // Plunk Lite: /v1/track takes a public key, so anyone can post to it; its data is at most 32 KB
  app.use('/v1/track', json({limit: '64kb'}));
  app.use(json({limit: '2mb'}));
}
