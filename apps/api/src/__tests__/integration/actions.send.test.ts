import {promises as dns} from 'node:dns';
import {EventEmitter} from 'node:events';
import {TemplateType} from '@plunk/db';
import type {Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions.js';
import {HttpException} from '../../exceptions/index.js';
import {idempotency} from '../../middleware/idempotency.js';
import {EmailService} from '../../services/EmailService.js';

type Outcome = {status: number; body?: {success: boolean; data: Record<string, unknown>}; error?: unknown};

/** A Response stand-in that records what the handler answered, and emits 'finish' like Express */
function createResponse(projectId: string) {
  const res = new EventEmitter() as unknown as Response & {statusCode: number};
  res.locals = {auth: {type: 'secret', projectId}};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  return res;
}

/** Run /v1/send (behind the idempotency middleware when given a key) until it answers */
async function send(projectId: string, body: Record<string, unknown>, key?: string): Promise<Outcome> {
  const req = {
    method: 'POST',
    path: '/v1/send',
    headers: key ? {'idempotency-key': key} : {},
    body,
  } as unknown as Request;
  const res = createResponse(projectId);

  const outcome = await new Promise<Outcome>(resolve => {
    res.json = ((json: Outcome['body']) => {
      resolve({status: res.statusCode, body: json});
      return res;
    }) as Response['json'];
    const handler = (error?: unknown) => {
      if (error) {
        resolve({status: error instanceof HttpException ? error.code : 500, error});
        return;
      }
      new Actions().send(req, res, (handlerError?: unknown) =>
        resolve({
          status: handlerError instanceof HttpException ? handlerError.code : 500,
          error: handlerError,
        }),
      );
    };
    if (key) {
      void idempotency(req, res, handler);
    } else {
      handler();
    }
  });

  // What the idempotency middleware does with the claim once the response is out
  res.statusCode = outcome.status;
  res.emit('finish');
  return outcome;
}

/**
 * Plunk Lite: /v1/send with several recipients goes on past one that fails, and says which did.
 */
describe('POST /v1/send with several recipients', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let templateId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com', verified: true});
    const template = await factories.createTemplate({projectId, type: TemplateType.MARKETING});
    templateId = template.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends to the others when one is unsubscribed, and answers 207 with the one that failed', async () => {
    await factories.createContact({projectId, email: 'second@example.com', subscribed: false});
    await factories.createContact({projectId, email: 'first@example.com', subscribed: true});
    await factories.createContact({projectId, email: 'third@example.com', subscribed: true});

    const outcome = await send(projectId, {
      to: ['first@example.com', 'second@example.com', 'third@example.com'],
      template: templateId,
    });

    expect(outcome.status).toBe(207);
    const data = outcome.body!.data as {emails: {contact: {email: string}}[]; failed: {email: string; code: string}[]};
    expect(data.emails.map(email => email.contact.email)).toEqual(['first@example.com', 'third@example.com']);
    expect(data.failed).toEqual([expect.objectContaining({email: 'second@example.com', code: 'BAD_REQUEST'})]);
    expect(await prisma.email.count({where: {projectId}})).toBe(2);
  });

  it('answers 200 without `failed` when every recipient was sent', async () => {
    const outcome = await send(projectId, {
      to: ['a@example.com', 'b@example.com'],
      subject: 'Hi',
      body: '<p>Hi</p>',
      from: 'hello@example.com',
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body!.data).not.toHaveProperty('failed');
  });

  it('answers with the error, and sends nothing, when every recipient fails', async () => {
    await factories.createContact({projectId, email: 'a@example.com', subscribed: false});
    await factories.createContact({projectId, email: 'b@example.com', subscribed: false});

    const outcome = await send(projectId, {to: ['a@example.com', 'b@example.com'], template: templateId});

    expect(outcome.status).toBe(400);
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
  });

  it('stops at an unexpected error and marks the rest as not attempted', async () => {
    const real = EmailService.sendTransactionalEmail.bind(EmailService);
    vi.spyOn(EmailService, 'sendTransactionalEmail')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('database went away'));

    const outcome = await send(projectId, {
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
      subject: 'Hi',
      body: '<p>Hi</p>',
      from: 'hello@example.com',
    });

    expect(outcome.status).toBe(207);
    const data = outcome.body!.data as {emails: unknown[]; failed: {email: string; code: string}[]};
    expect(data.emails).toHaveLength(1);
    expect(data.failed).toEqual([
      expect.objectContaining({email: 'b@example.com', code: 'INTERNAL_SERVER_ERROR'}),
      expect.objectContaining({email: 'c@example.com', code: 'NOT_ATTEMPTED'}),
    ]);
  });

  it('keeps the idempotency key of a partial send, so a retry cannot send twice', async () => {
    await factories.createContact({projectId, email: 'b@example.com', subscribed: false});
    const body = {to: ['a@example.com', 'b@example.com'], template: templateId};
    await factories.createContact({projectId, email: 'a@example.com', subscribed: true});

    const first = await send(projectId, body, 'retry-key');
    await vi.waitFor(async () => {
      const claim = await prisma.idempotencyKey.findFirst({where: {projectId, key: 'retry-key'}});
      expect(claim?.statusCode).toBe(207);
    });
    const retry = await send(projectId, body, 'retry-key');

    expect(first.status).toBe(207);
    expect(retry.status).toBe(409);
    expect(await prisma.email.count({where: {projectId}})).toBe(1);
  });

  it('keeps the key when nothing was sent but an unexpected error may have queued an email', async () => {
    await factories.createContact({projectId, email: 'a@example.com', subscribed: false});
    await factories.createContact({projectId, email: 'b@example.com', subscribed: true});
    const real = EmailService.sendTransactionalEmail.bind(EmailService);
    vi.spyOn(EmailService, 'sendTransactionalEmail')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('queue went away'));

    const outcome = await send(projectId, {to: ['a@example.com', 'b@example.com'], template: templateId}, 'kept-key');

    expect(outcome.status).toBe(500);
    await vi.waitFor(async () => {
      const claim = await prisma.idempotencyKey.findFirst({where: {projectId, key: 'kept-key'}});
      expect(claim?.statusCode).toBe(500);
    });
  });

  describe('new recipients whose address takes no email (Plunk Lite)', () => {
    beforeEach(() => {
      process.env.PLUNK_LITE_VERIFY_SIGNUPS = 'true';
      // Only typo.test fails to resolve
      vi.spyOn(dns.Resolver.prototype, 'resolveMx').mockImplementation(async (domain: string) => {
        if (domain === 'typo.test') throw Object.assign(new Error('queryMx ENOTFOUND'), {code: 'ENOTFOUND'});
        return [{exchange: 'mx.example.org', priority: 10}];
      });
    });

    afterEach(() => {
      process.env.PLUNK_LITE_VERIFY_SIGNUPS = 'false';
    });

    const message = {subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'};

    it('lists one among others under `failed` with INVALID_EMAIL', async () => {
      const outcome = await send(projectId, {to: ['ana@shop.test', 'luis@typo.test'], ...message});

      expect(outcome.status).toBe(207);
      expect(outcome.body!.data.failed).toEqual([
        expect.objectContaining({email: 'luis@typo.test', code: 'INVALID_EMAIL'}),
      ]);
      expect(await prisma.contact.count({where: {projectId, email: 'luis@typo.test'}})).toBe(0);
    });

    it('answers 422 when it was the only recipient', async () => {
      const outcome = await send(projectId, {to: 'luis@typo.test', ...message});

      expect(outcome.status).toBe(422);
      expect(await prisma.email.count({where: {projectId}})).toBe(0);
    });
  });
});
