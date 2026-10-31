import type {Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {HttpException} from '../../exceptions/index.js';
import {FailureAlertService} from '../../services/FailureAlertService.js';
import {MembershipService} from '../../services/MembershipService.js';
import {QueueService} from '../../services/QueueService.js';
import {Alerts} from '../Alerts.js';

vi.mock('../../services/FailureAlertService.js', () => ({
  FailureAlertService: {
    getSettings: vi.fn(async () => null),
    saveSettings: vi.fn(async (_id: string, settings: unknown) => settings),
    sendTest: vi.fn(async () => undefined),
    listOpen: vi.fn(async () => []),
    review: vi.fn(async () => 1),
  },
}));
vi.mock('../../services/QueueService.js', () => ({
  QueueService: {queueDlqDrain: vi.fn(async () => ({}))},
}));
vi.mock('../../services/MembershipService.js', () => ({
  MembershipService: {requireAccess: vi.fn(async () => ({})), requireAdminAccess: vi.fn(async () => ({}))},
}));

const PROJECT = '3f1c2a8e-7b4d-4c3a-9e2f-1a2b3c4d5e6f';
const FAILURE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SESSION = {type: 'jwt', userId: 'user-1', projectId: PROJECT};

type Handler = 'getSettings' | 'saveSettings' | 'sendTest' | 'listFailures' | 'reviewFailures' | 'drainDeadLetterQueue';

/** Calls a handler as Express would, as in Footers.test.ts */
async function call(handler: Handler, auth: Record<string, unknown>, body?: unknown) {
  let status = 200;
  let json: unknown;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth},
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        json = value;
        resolve();
        return this;
      },
    } as unknown as Response;
    new Alerts()[handler]({params: {id: PROJECT}, body} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, json, error};
}

describe('/projects/:id/alerts', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lets any member see and review failures', async () => {
    expect((await call('listFailures', SESSION)).json).toEqual({failures: []});

    const lastAt = new Date().toISOString();
    const {json} = await call('reviewFailures', SESSION, {seen: [{id: FAILURE, lastAt}]});

    expect(json).toEqual({reviewed: 1});
    expect(FailureAlertService.review).toHaveBeenCalledWith(PROJECT, [{id: FAILURE, lastAt}]);
    expect(MembershipService.requireAccess).toHaveBeenCalledWith('user-1', PROJECT);
    expect(MembershipService.requireAdminAccess).not.toHaveBeenCalled();
  });

  it('lets admins save the addresses, trimmed and lowercased', async () => {
    const {json} = await call('saveSettings', SESSION, {
      recipients: [' Ops@Example.org '],
      fromEmail: 'Alerts@Example.com',
    });

    expect(json).toEqual({settings: {recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'}});
    expect(MembershipService.requireAdminAccess).toHaveBeenCalledWith('user-1', PROJECT);
  });

  it('checks the member is an admin before changing anything or sending a test', async () => {
    vi.mocked(MembershipService.requireAdminAccess)
      .mockRejectedValueOnce(new HttpException(403, 'Admin only'))
      .mockRejectedValueOnce(new HttpException(403, 'Admin only'));

    for (const handler of ['saveSettings', 'sendTest'] as const) {
      expect(((await call(handler, SESSION, {recipients: []})).error as HttpException).code).toBe(403);
    }
    expect(FailureAlertService.saveSettings).not.toHaveBeenCalled();
    expect(FailureAlertService.sendTest).not.toHaveBeenCalled();
  });

  it('refuses invalid addresses, too many of them, and a review without what was seen', async () => {
    for (const body of [
      {recipients: ['not an email']},
      {recipients: Array.from({length: 11}, (_, i) => `a${i}@x.org`)},
    ]) {
      expect(((await call('saveSettings', SESSION, body)).error as HttpException).code).toBe(400);
    }
    for (const body of [
      {},
      {seen: []},
      {seen: [{id: 'x', lastAt: new Date().toISOString()}]},
      {seen: [{id: FAILURE, lastAt: 'yesterday'}]},
    ]) {
      expect(((await call('reviewFailures', SESSION, body)).error as HttpException).code).toBe(400);
    }
    expect(FailureAlertService.saveSettings).not.toHaveBeenCalled();
    expect(FailureAlertService.review).not.toHaveBeenCalled();
  });

  it('shows what SES said when the test alert fails', async () => {
    vi.mocked(FailureAlertService.sendTest).mockRejectedValueOnce(new Error('Email address is not verified.'));

    const {error} = await call('sendTest', SESSION);

    expect((error as HttpException).code).toBe(400);
    expect((error as HttpException).message).toBe('Email address is not verified.');
  });

  it('lets admins drain the AWS dead-letter queue, saying nothing of what it holds', async () => {
    const {status, json} = await call('drainDeadLetterQueue', SESSION);

    expect(status).toBe(202);
    expect(json).toEqual({queued: true});
    expect(QueueService.queueDlqDrain).toHaveBeenCalledOnce();
    expect(MembershipService.requireAdminAccess).toHaveBeenCalledWith('user-1', PROJECT);
  });

  it('does not let a member drain the dead-letter queue', async () => {
    vi.mocked(MembershipService.requireAdminAccess).mockRejectedValueOnce(new HttpException(403, 'Admin only'));

    expect(((await call('drainDeadLetterQueue', SESSION)).error as HttpException).code).toBe(403);
    expect(QueueService.queueDlqDrain).not.toHaveBeenCalled();
  });

  it('refuses API keys', async () => {
    for (const handler of [
      'getSettings',
      'saveSettings',
      'sendTest',
      'listFailures',
      'reviewFailures',
      'drainDeadLetterQueue',
    ] as const) {
      expect(((await call(handler, {type: 'apiKey', projectId: PROJECT}, {})).error as HttpException).code).toBe(403);
    }
  });
});
