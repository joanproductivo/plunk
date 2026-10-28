import {Server} from '@overnightjs/core';
import express, {type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';

type Outcome = {status: number; body?: {success: boolean; data: Record<string, unknown>}};

/**
 * Plunk Lite: /v1/track takes the secret key too, from a server, in one call -- also with the public
 * key switched off (PLUNK_LITE_PUBLIC_TRACK=off), which then shuts out only the public key.
 */
describe('POST /v1/track with the secret key', () => {
  const prisma = getPrismaClient();
  let project: {id: string; public: string; secret: string};

  beforeEach(async () => {
    project = (await factories.createUserWithProject()).project;
  });

  afterEach(() => {
    delete process.env.PLUNK_LITE_PUBLIC_TRACK;
    vi.resetModules();
  });

  /** Run /v1/track behind its key middleware, as the server is set up with `publicTrack` */
  async function track(key: string, body: Record<string, unknown>, publicTrack?: string): Promise<Outcome> {
    if (publicTrack === undefined) {
      delete process.env.PLUNK_LITE_PUBLIC_TRACK;
    } else {
      process.env.PLUNK_LITE_PUBLIC_TRACK = publicTrack;
    }
    vi.resetModules();
    const {requireTrackKey} = await import('../../middleware/auth.js');
    const {Actions} = await import('../../controllers/Actions.js');

    const req = {method: 'POST', path: '/v1/track', headers: {authorization: `Bearer ${key}`}, body} as Request;
    const res = {locals: {}, statusCode: 200} as Response;
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };

    return new Promise<Outcome>(resolve => {
      // The modules are loaded afresh, so their HttpException is not this file's: read its code
      const failed: NextFunction = (error?: unknown) => {
        const code = (error as {code?: unknown} | undefined)?.code;
        resolve({status: typeof code === 'number' ? code : 500});
      };
      res.json = ((json: Outcome['body']) => {
        resolve({status: res.statusCode, body: json});
        return res;
      }) as Response['json'];
      void requireTrackKey(req, res, (error?: unknown) => {
        if (error) {
          failed(error);
          return;
        }
        void new Actions().track(req, res, failed);
      });
    });
  }

  it("creates the contact and its event in the key's project, in one call", async () => {
    const outcome = await track(project.secret, {event: 'newsletter.signup', email: 'ana@example.com'});

    expect(outcome.status).toBe(200);
    const contact = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, email: 'ana@example.com'}});
    expect(outcome.body?.data.contact).toBe(contact.id);
    expect(await prisma.event.count({where: {projectId: project.id, contactId: contact.id}})).toBe(1);
  });

  it('refuses a secret key no project has', async () => {
    const outcome = await track('sk_nobodyhasthiskey123', {event: 'newsletter.signup', email: 'ana@example.com'});

    expect(outcome.status).toBe(401);
  });

  it('still takes the secret key with the public key switched off, and only the public key gets 403', async () => {
    const body = {event: 'newsletter.signup', email: 'leo@example.com'};

    expect((await track(project.secret, body, 'off')).status).toBe(200);
    expect((await track(project.public, body, 'off')).status).toBe(403);
    expect((await track('sk_nobodyhasthiskey123', body, 'off')).status).toBe(401);
  });

  it('is the key check the route itself runs', async () => {
    vi.resetModules();
    const {Actions} = await import('../../controllers/Actions.js');
    const server = new (class extends Server {
      constructor() {
        super();
        this.app.use(express.json());
        this.addControllers([new Actions()]);
        this.app.use((error: {code?: number}, _req: Request, res: Response, _next: NextFunction) => {
          res.status(typeof error.code === 'number' ? error.code : 500).json({});
        });
      }
    })();

    const response = await request(server.app)
      .post('/v1/track')
      .set('Authorization', `Bearer ${project.secret}`)
      .send({event: 'newsletter.signup', email: 'max@example.com'});

    expect(response.status).toBe(200);
  });

  it('keeps taking the public key by default', async () => {
    const outcome = await track(project.public, {event: 'newsletter.signup', email: 'eva@example.com'});

    expect(outcome.status).toBe(200);
  });
});
