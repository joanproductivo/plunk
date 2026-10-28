import http from 'node:http';
import type {AddressInfo} from 'node:net';

import express from 'express';
import type {NextFunction, Request, Response} from 'express';
import request from 'supertest';
import {describe, expect, it, vi} from 'vitest';

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

  it('takes at most 64 KB on /v1/track, which takes the public key', async () => {
    const over = await request(appWithParsers())
      .post('/v1/track')
      .send({filler: 'x'.repeat(100 * 1024)});
    const within = await request(appWithParsers())
      .post('/v1/track')
      .send({filler: 'x'.repeat(32 * 1024)});

    expect(over.status).toBe(413);
    expect(within.status).toBe(200);
  });

  it('refuses a large body on the SNS webhook', async () => {
    const response = await request(appWithParsers()).post('/webhooks/sns').send(bodyOf(3));

    expect(response.status).toBe(413);
  });

  it('accepts on /v1/send a body with attachments up to what nginx allows', async () => {
    const response = await request(appWithParsers()).post('/v1/send').send(bodyOf(9));

    expect(response.status).toBe(200);
  });

  it('turns away large sends beyond the ones already in progress', async () => {
    const app = express();
    useJsonBodyParsers(app);
    // Sends that hold on to their request until released, as a slow key check or send would
    const held: Response[] = [];
    app.post('/v1/send', (_req: Request, res: Response) => {
      held.push(res);
    });
    app.use((error: {code?: number}, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.code ?? 500).json({});
    });
    const server = app.listen(0);
    const {port} = server.address() as AddressInfo;

    /** One POST to /v1/send, resolved with its status */
    const send = (body: object) =>
      new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            port,
            method: 'POST',
            path: '/v1/send',
            headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)},
          },
          res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(payload);
      });

    const release = () => held.splice(0).forEach(res => res.json({}));

    try {
      const inFlight = Array.from({length: 8}, () => send(bodyOf(3)));
      await vi.waitFor(() => expect(held).toHaveLength(8), {timeout: 10_000});

      expect(await send(bodyOf(3))).toBe(503);
      // A small send is never held up by the large ones
      const small = send({to: 'a@b.test'});
      await vi.waitFor(() => expect(held).toHaveLength(9));

      release();
      expect(await Promise.all([...inFlight, small])).toEqual(Array(9).fill(200));

      // The slots are free again
      const next = send(bodyOf(3));
      await vi.waitFor(() => expect(held).toHaveLength(1), {timeout: 10_000});
      release();
      expect(await next).toBe(200);
    } finally {
      release();
      server.close();
    }
  });

  it('accepts an ordinary body anywhere', async () => {
    const response = await request(appWithParsers()).post('/contacts').send({email: 'a@b.test'});

    expect(response.status).toBe(200);
  });
});
