import {TemplateType} from '@plunk/db';
import type {Request} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createResponse, factories, getPrismaClient, runHandler} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions.js';
import {Contacts} from '../../controllers/Contacts.js';
import {OptIn} from '../../controllers/OptIn.js';
import {OptInSettings} from '../../controllers/OptInSettings.js';
import {requireTrackKey} from '../../middleware/auth.js';
import {QueueService} from '../../services/QueueService.js';

type Body = Record<string, unknown> & {data?: Record<string, unknown>};

/**
 * Plunk Lite's double opt-in through the API: what each way in does with a sign-up, and the
 * confirmation page's endpoints.
 */
describe('double opt-in', () => {
  const prisma = getPrismaClient();
  let project: {id: string; public: string; secret: string};
  let userId: string;
  let segmentId: string;

  beforeEach(async () => {
    const created = await factories.createUserWithProject();
    project = created.project;
    userId = created.user.id;
    await factories.createDomain({projectId: project.id, domain: 'plunk.test'});
    await prisma.plunkLiteOptInSettings.create({
      data: {projectId: project.id, enabled: true, fromEmail: 'hello@plunk.test', texts: {}},
    });
    segmentId = (
      await prisma.segment.create({
        data: {projectId: project.id, name: 'Promo', type: 'STATIC', trackMembership: true},
      })
    ).id;
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const apiKey = {type: 'apiKey', key: 'secret'};
  const contactNamed = (email: string) => prisma.contact.findFirst({where: {projectId: project.id, email}});
  const members = () => prisma.segmentMembership.count({where: {segmentId, exitedAt: null}});

  async function tokenOf(email: string) {
    const contact = await contactNamed(email);
    const request = await prisma.plunkLiteOptInRequest.findUniqueOrThrow({where: {contactId: contact!.id}});
    const sent = await prisma.email.findUniqueOrThrow({where: {id: request.emailId!}});
    return /\/confirm#([\w-]+)/.exec(sent.body)![1]!;
  }

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
      createResponse({auth: {...apiKey, projectId: project.id}}),
    );
  }

  function confirm(token: string) {
    const optIn = new OptIn();
    return runHandler<Body>(optIn.confirm.bind(optIn), {body: {token}} as Request, createResponse());
  }

  describe('/v1/track', () => {
    it('with the secret key, keeps the sign-up waiting and joins its segments on confirming', async () => {
      const outcome = await track(project.secret, {
        event: 'signup',
        email: 'ana@plunk.test',
        subscribed: true,
        segments: [segmentId],
        data: {locale: 'es'},
      });

      expect(outcome.status).toBe(200);
      expect(outcome.body!.data).toMatchObject({pendingConfirmation: true, optIn: 'sent'});
      expect((await contactNamed('ana@plunk.test'))!.subscribed).toBe(false);
      expect(await members()).toBe(0);
      const sent = await prisma.email.findFirstOrThrow({where: {projectId: project.id}});
      expect(sent.subject).toBe(
        `Confirma tu suscripción a ${(await prisma.project.findUniqueOrThrow({where: {id: project.id}})).name}`,
      );

      expect((await confirm(await tokenOf('ana@plunk.test'))).body).toEqual({status: 'confirmed'});
      expect((await contactNamed('ana@plunk.test'))!.subscribed).toBe(true);
      expect(await members()).toBe(1);
    });

    it('with the public key, sends nothing and leaves the contact unsubscribed', async () => {
      const outcome = await track(project.public, {event: 'signup', email: 'ana@plunk.test', subscribed: true});

      expect(outcome.status).toBe(200);
      expect(outcome.body!.data).toMatchObject({pendingConfirmation: false, optIn: 'held'});
      expect((await contactNamed('ana@plunk.test'))!.subscribed).toBe(false);
      expect(await prisma.email.count({where: {projectId: project.id}})).toBe(0);
      expect(await prisma.plunkLiteOptInRequest.count()).toBe(0);
    });
  });

  describe('/v1/send', () => {
    it('refuses a sign-up with a marketing template before writing anything', async () => {
      const template = await factories.createTemplate({projectId: project.id, type: TemplateType.MARKETING});

      const outcome = await send({
        to: 'ana@plunk.test',
        template: template.id,
        subscribed: true,
        from: 'hello@plunk.test',
      });

      expect(outcome.status).toBe(422);
      expect(await contactNamed('ana@plunk.test')).toBeNull();
    });

    it('sends its own email and the confirmation, and leaves the segments for the confirmation', async () => {
      const outcome = await send({
        to: 'ana@plunk.test',
        subject: 'Welcome',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        subscribed: true,
        segments: [segmentId],
      });

      expect(outcome.status).toBe(200);
      expect((await contactNamed('ana@plunk.test'))!.subscribed).toBe(false);
      expect(await prisma.email.count({where: {projectId: project.id}})).toBe(2);
      expect(await members()).toBe(0);
    });
  });

  describe('POST /contacts', () => {
    function create(auth: Record<string, unknown>, body: Record<string, unknown>) {
      const contacts = new Contacts();
      return runHandler<Body>(contacts.create.bind(contacts), {body} as Request, createResponse({auth}));
    }

    it('keeps a sign-up from an API key waiting', async () => {
      const outcome = await create({...apiKey, projectId: project.id}, {email: 'ana@plunk.test', subscribed: true});
      expect(outcome.body).toMatchObject({subscribed: false, _meta: {pendingConfirmation: true, optIn: 'sent'}});
    });

    it("subscribes from the dashboard's form", async () => {
      const outcome = await create({type: 'jwt', userId, projectId: project.id}, {email: 'ana@plunk.test'});
      expect(outcome.body).toMatchObject({subscribed: true});
      expect((outcome.body!._meta as Record<string, unknown>).pendingConfirmation).toBeUndefined();
    });
  });

  describe('the contact list and page', () => {
    function list(query: Record<string, string>) {
      const contacts = new Contacts();
      return runHandler<Body>(
        contacts.list.bind(contacts),
        {query} as unknown as Request,
        createResponse({auth: {...apiKey, projectId: project.id}}),
      );
    }

    it('filters the contacts waiting for confirmation and marks every row', async () => {
      await track(project.secret, {event: 'signup', email: 'ana@plunk.test'});
      await factories.createContact({projectId: project.id, email: 'bea@plunk.test', subscribed: false});

      const pending = await list({status: 'pending'});
      expect(pending.body).toMatchObject({total: 1, data: [{email: 'ana@plunk.test', pendingConfirmation: true}]});

      const all = (await list({sort: 'email', dir: 'asc'})).body!.data as unknown as Record<string, unknown>[];
      expect(all.map(row => [row.email, row.pendingConfirmation])).toEqual([
        ['ana@plunk.test', true],
        ['bea@plunk.test', false],
      ]);
    });

    it("tells the contact's page when it asked and whether it confirmed", async () => {
      await track(project.secret, {event: 'signup', email: 'ana@plunk.test'});
      const contact = await contactNamed('ana@plunk.test');
      const contacts = new Contacts();

      const outcome = await runHandler<Body>(
        contacts.get.bind(contacts),
        {params: {id: contact!.id}} as unknown as Request,
        createResponse({auth: {...apiKey, projectId: project.id}}),
      );

      expect(outcome.body).toMatchObject({pendingConfirmation: true, optIn: {sends: 1, confirmedAt: null}});
    });
  });

  describe('the confirmation page', () => {
    it('describes a link without confirming it, and confirms it once pressed', async () => {
      await track(project.secret, {event: 'signup', email: 'ana@plunk.test'});
      const token = await tokenOf('ana@plunk.test');
      const optIn = new OptIn();

      const described = await runHandler<Body>(
        optIn.describe.bind(optIn),
        {body: {token}} as Request,
        createResponse(),
      );
      expect(described.body).toMatchObject({status: 'pending', email: 'ana@plunk.test', language: 'en'});
      expect((await contactNamed('ana@plunk.test'))!.subscribed).toBe(false);

      expect((await confirm(token)).body).toEqual({status: 'confirmed'});
      expect((await confirm('not-a-token-at-all-and-long-enough')).body).toEqual({status: 'invalid'});
      expect(
        (await runHandler<Body>(optIn.describe.bind(optIn), {body: {}} as Request, createResponse())).body,
      ).toEqual({
        status: 'invalid',
      });
    });
  });

  describe('settings', () => {
    function save(body: Record<string, unknown>, auth: Record<string, unknown> = {type: 'jwt', userId}) {
      const settings = new OptInSettings();
      return runHandler<Body>(
        settings.saveSettings.bind(settings),
        {params: {id: project.id}, body} as unknown as Request,
        createResponse({auth}),
      );
    }

    it('saves the switch, the sender and the texts from the dashboard only', async () => {
      const texts = {es: {subject: 'Confirma', text: 'Hola {projectName}', buttonText: 'Confirmar'}};

      const body = {enabled: true, fromEmail: 'news@plunk.test', fromName: 'News', texts};

      expect((await save(body)).body).toMatchObject(body);
      expect((await save(body, {...apiKey, projectId: project.id})).status).toBe(403);
      // A text with template tags, and a body without its fields
      const tags = {es: {subject: '{{ x }}', text: 'a', buttonText: 'Confirm'}};
      expect((await save({...body, texts: tags})).status).toBe(400);
      expect((await save({enabled: true})).status).toBe(400);
    });
  });
});
