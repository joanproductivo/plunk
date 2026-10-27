import type {Application} from 'express';
import {json} from 'express';

/**
 * Parse JSON bodies. Bodies are parsed before any route checks who is asking, so the limit
 * applies to anonymous requests too: only /v1/send, whose attachments travel in the body, gets
 * as much as nginx lets through in front of it (client_max_body_size 10M). Every other body is
 * small -- the largest, lists of up to 10,000 ids -- and 2 MB keeps unauthenticated requests
 * from filling the heap. A body over its limit fails with `type: 'entity.too.large'`.
 */
export function useJsonBodyParsers(app: Application): void {
  app.use('/v1/send', json({limit: '10mb'}));
  app.use(json({limit: '2mb'}));
}
