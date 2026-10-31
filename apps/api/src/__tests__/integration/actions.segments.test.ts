import {TemplateType} from '@plunk/db';
import type {Request} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {createResponse, factories, getPrismaClient, runHandler} from '../../../../../test/helpers';
import {prisma as servicePrisma} from '../../database/prisma.js';
import {Actions} from '../../controllers/Actions.js';
import {HttpException} from '../../exceptions/index.js';
import {requireTrackKey} from '../../middleware/auth.js';
import {EventService} from '../../services/EventService.js';
import {QueueService} from '../../services/QueueService.js';
import {SegmentMembershipService} from '../../services/SegmentMembershipService.js';

type Body = {success: boolean; data: Record<string, unknown>};

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
    return runHandler<Body>(actions.track.bind(actions), req, createResponse(), requireTrackKey);
  }

  function send(body: Record<string, unknown>) {
    const req = {method: 'POST', path: '/v1/send', headers: {}, body} as unknown as Request;
    const actions = new Actions();
    return runHandler<Body>(
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
        // The contact is already in both segments when its event is tracked
        order.push(`event with ${(await members(first)).length + (await members(second)).length} memberships`);
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
      expect(order).toEqual(['event with 2 memberships', 'entry', 'entry']);
    });

    it('skips a segment deleted after it was checked, and adds the contact to the others', async () => {
      const resolve = SegmentMembershipService.resolveStaticSegments.bind(SegmentMembershipService);
      vi.spyOn(SegmentMembershipService, 'resolveStaticSegments').mockImplementation(async (...args) => {
        const segments = await resolve(...args);
        await prisma.segment.delete({where: {id: first}});
        return segments;
      });

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        segments: [first, second],
      });

      expect(outcome.status).toBe(200);
      expect(await members(second)).toHaveLength(1);
      expect(QueueService.queueSegmentMembershipEvents).toHaveBeenCalledTimes(1);
    });

    it('still queues the entry events of the segments written when a later one fails', async () => {
      const create = servicePrisma.segmentMembership.createManyAndReturn.bind(servicePrisma.segmentMembership);
      vi.spyOn(servicePrisma.segmentMembership, 'createManyAndReturn')
        .mockImplementationOnce(create as never)
        .mockRejectedValueOnce(new Error('database went away'));

      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@example.com',
        segments: [first, second],
      });

      expect(outcome.status).toBe(500);
      expect(await members(first)).toHaveLength(1);
      expect(QueueService.queueSegmentMembershipEvents).toHaveBeenCalledTimes(1);
      expect(vi.mocked(QueueService.queueSegmentMembershipEvents).mock.calls[0]![0]).toMatchObject({segmentId: first});
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

    it('still adds the other recipients when one of their contacts is deleted before they enter', async () => {
      const enterSegments = SegmentMembershipService.enterSegments.bind(SegmentMembershipService);
      vi.spyOn(SegmentMembershipService, 'enterSegments').mockImplementationOnce(async (projectId, segments, ids) => {
        await prisma.contact.delete({where: {id: ids[0]!}});
        return enterSegments(projectId, segments, ids);
      });

      const outcome = await send({
        to: ['a@example.com', 'b@example.com'],
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@example.com',
        segments: [first],
      });

      expect(outcome.status).toBe(200);
      expect(await members(first)).toHaveLength(1);
      expect(outcome.body!.data).not.toHaveProperty('segmentsError');
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
