import express from 'express';
import type {NextFunction, Request, Response} from 'express';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {useJsonBodyParsers} from '../bodyParsers';

/**
 * Bodies are parsed before authentication, so their size limit is what anonymous requests get.
 * Only /v1/send, which carries attachments, may send as much as nginx lets through.
 */
describe('useJsonBodyParsers', () => {
  function appWithParsers() {
    const app = express();
    useJsonBodyParsers(app);
    app.post(/.*/, (req: Request, res: Response) => {
      res.json({received: JSON.stringify(req.body).length});
    });
    app.use((error: {type?: string; status?: number}, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.status ?? 500).json({type: error.type});
    });
    return app;
  }

  /** A JSON body of about `megabytes` MB */
  const bodyOf = (megabytes: number) => ({filler: 'x'.repeat(megabytes * 1024 * 1024)});

  it('refuses a body over 2 MB on a route without attachments, as too large', async () => {
    const response = await request(appWithParsers()).post('/auth/login').send(bodyOf(3));

    expect(response.status).toBe(413);
    expect(response.body.type).toBe('entity.too.large');
  });

  it('refuses a large body on the SNS webhook', async () => {
    const response = await request(appWithParsers()).post('/webhooks/sns').send(bodyOf(3));

    expect(response.status).toBe(413);
  });

  it('accepts on /v1/send a body with attachments up to what nginx allows', async () => {
    const response = await request(appWithParsers()).post('/v1/send').send(bodyOf(9));

    expect(response.status).toBe(200);
  });

  it('accepts an ordinary body anywhere', async () => {
    const response = await request(appWithParsers()).post('/contacts').send({email: 'a@b.test'});

    expect(response.status).toBe(200);
  });
});
