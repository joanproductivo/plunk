import {EventEmitter} from 'node:events';
import {TemplateType} from '@plunk/db';
import type {NextFunction, Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions.js';
import {HttpException} from '../../exceptions/index.js';
import {requireTrackKey} from '../../middleware/auth.js';
import {EventService} from '../../services/EventService.js';
import {QueueService} from '../../services/QueueService.js';
import {SegmentMembershipService} from '../../services/SegmentMembershipService.js';

type Outcome = {status: number; body?: {success: boolean; data: Record<string, unknown>}; error?: unknown};

/** A Response stand-in that records what the handler answered */
function createResponse(locals: Record<string, unknown> = {}) {
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
function run(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
  res: Response & {statusCode: number},
  middleware?: (req: Request, res: Response, next: NextFunction) => unknown,
): Promise<Outcome> {
  return new Promise<Outcome>(resolve => {
    const failed = (error?: unknown) => resolve({status: error instanceof HttpException ? error.code : 500, error});
    res.json = ((json: Outcome['body']) => {
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

/**
 * Plunk Lite: /v1/track and /v1/send take `segments`, the static segments their contacts join in the
 * same call -- with the secret key only, all checked before anything is written.
 */
describe('segments on /v1/track and /v1/send', () => {
  const prisma = getPrismaClient();
  let project: {id: string; public: string; secret: string};
  let first: string;
  let second: string;

  beforeEach(async () => {
    project = (await factories.createUserWithProject()).project;
    const segment = (name: string) =>
      prisma.segment.create({data: {projectId: project.id, name, type: 'STATIC', trackMembership: true}});
    first = (await segment('Newsletter')).id;
    second = (await segment('Dieta')).id;
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const members = (segmentId: string) =>
    prisma.segmentMembership.findMany({where: {segmentId, exitedAt: null}, select: {contactId: true}});

  function track(key: string, body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/track', headers: {authorization: `Bearer ${key}`}, body} as Request;
    const actions = new Actions();
    return run(actions.track.bind(actions), req, createResponse(), requireTrackKey);
  }

  function send(body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/send', headers: {}, body} as unknown as Request;
    const actions = new Actions();
    return run(
      actions.send.bind(actions),
      req,
      createResponse({auth: {type: 'apiKey', projectId: project.id, key: 'secret'}}),
    );
  }

  describe('/v1/track', () => {
    it('adds the contact to each segment before its event, and queues their entry events after it', async () => {
      const order: string[] = [];
      const trackEvent = EventService.trackEvent.bind(EventService);
      vi.spyOn(EventService, 'trackEvent').mockImplementation(async (...args) => {
        order.push('event');
        return trackEvent(...args);
      });
      vi.mocked(QueueService.queueSegmentMembershipEvents).mockImplementation(async () => {
        order.push('entry');
        return {} as never;
      });

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        segments: [first, second, first],
      });

      expect(outcome.status).toBe(200);
      const contactId = outcome.body!.data.contact as string;
      expect(await members(first)).toEqual([{contactId}]);
      expect(await members(second)).toEqual([{contactId}]);
      expect(order).toEqual(['event', 'entry', 'entry']);
    });

    it('refuses segments with the public key, and writes nothing', async () => {
      const outcome = await track(project.public, {event: 'signup', email: 'ana@example.com', segments: [first]});

      expect(outcome.status).toBe(403);
      expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(0);
    });

    it('still takes the public key without segments, or with an empty list', async () => {
      expect((await track(project.public, {event: 'signup', email: 'ana@example.com'})).status).toBe(200);
      expect((await track(project.public, {event: 'signup', email: 'leo@example.com', segments: []})).status).toBe(200);
    });

    it('refuses a dynamic, foreign or unknown segment with 422, naming each, and writes nothing', async () => {
      const dynamic = await prisma.segment.create({
        data: {projectId: project.id, name: 'VIP', type: 'DYNAMIC', condition: {logic: 'AND', groups: []}},
      });
      const other = (await factories.createUserWithProject()).project;
      const foreign = await prisma.segment.create({data: {projectId: other.id, name: 'Other', type: 'STATIC'}});

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        segments: [first, dynamic.id, foreign.id, '00000000-0000-4000-8000-000000000000'],
      });

      expect(outcome.status).toBe(422);
      const fields = (outcome.error as HttpException).details?.errors as {field: string; code: string}[];
      expect(fields.map(error => [error.field, error.code])).toEqual([
        ['segments.1', 'segment_not_static'],
        ['segments.2', 'segment_not_found'],
        ['segments.3', 'segment_not_found'],
      ]);
      expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(0);
      expect(await members(first)).toEqual([]);
    });

    it('refuses more than 20 segments, as the error handler answers a ZodError: 422', async () => {
      const segments = Array.from({length: 21}, () => first);

      const outcome = await track(project.secret, {event: 'signup', email: 'ana@example.com', segments});

      expect(outcome.error).toBeInstanceOf(ZodError);
      expect((outcome.error as ZodError).issues[0]!.path).toEqual(['segments']);
    });
  });

  describe('/v1/send', () => {
    beforeEach(async () => {
      await factories.createDomain({projectId: project.id, domain: 'example.com', verified: true});
    });

    it('adds every recipient sent to, once per segment', async () => {
      const outcome = await send({
        to: ['a@example.com', 'b@example.com'],
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@example.com',
        segments: [first],
      });

      expect(outcome.status).toBe(200);
      expect(await members(first)).toHaveLength(2);
      expect(QueueService.queueSegmentMembershipEvents).toHaveBeenCalledTimes(1);
      expect(outcome.body!.data).not.toHaveProperty('segmentsError');
    });

    it('leaves out a recipient whose email was refused', async () => {
      const template = await factories.createTemplate({projectId: project.id, type: TemplateType.MARKETING});
      await factories.createContact({projectId: project.id, email: 'out@example.com', subscribed: false});
      const kept = await factories.createContact({projectId: project.id, email: 'in@example.com', subscribed: true});

      const outcome = await send({to: ['in@example.com', 'out@example.com'], template: template.id, segments: [first]});

      expect(outcome.status).toBe(207);
      expect(await members(first)).toEqual([{contactId: kept.id}]);
    });

    it('refuses an invalid segment with 422 before sending anything', async () => {
      const outcome = await send({
        to: 'a@example.com',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@example.com',
        segments: ['00000000-0000-4000-8000-000000000000'],
      });

      expect(outcome.status).toBe(422);
      expect(await prisma.email.count({where: {projectId: project.id}})).toBe(0);
    });

    it('answers with the emails and segmentsError when adding to the segments fails after sending', async () => {
      vi.spyOn(SegmentMembershipService, 'enterSegments').mockRejectedValueOnce(new Error('database went away'));

      const outcome = await send({
        to: 'a@example.com',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@example.com',
        segments: [first],
      });

      expect(outcome.status).toBe(200);
      expect(outcome.body!.data.emails).toHaveLength(1);
      expect(outcome.body!.data.segmentsError).toMatch(/segments failed/);
    });
  });
});
