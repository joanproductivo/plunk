import {randomBytes} from 'node:crypto';

import type {NextFunction, Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as appPrisma} from '../../database/prisma';
import {redis, wrapRedis} from '../../database/redis';
import {ErrorCode} from '../../exceptions/index.js';
import {requireSecretKey} from '../../middleware/auth.js';
import {ProjectService} from '../ProjectService';

const newKey = (prefix: 'pk' | 'sk') => `${prefix}_${randomBytes(32).toString('hex')}`;

/**
 * Plunk Lite: the cached projects behind API keys see changes at once, and an unknown key is
 * remembered briefly instead of costing a query on every request.
 */
describe('ProjectService cache', () => {
  const prisma = getPrismaClient();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('looks an unknown key up once, then answers from the cache', async () => {
    const lookup = vi.spyOn(appPrisma.project, 'findUnique');
    const unknown = newKey('sk');

    expect(await ProjectService.secret(unknown)).toBeNull();
    expect(await ProjectService.secret(unknown)).toBeNull();

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('sees a project disabled at once once it is invalidated', async () => {
    const {project} = await factories.createUserWithProject();
    expect((await ProjectService.secret(project.secret))?.disabled).toBe(false);

    const disabled = await prisma.project.update({where: {id: project.id}, data: {disabled: true}});
    await ProjectService.invalidate(disabled);

    expect((await ProjectService.secret(project.secret))?.disabled).toBe(true);
  });

  it('drops the old keys and finds the new ones after regenerating', async () => {
    const {project} = await factories.createUserWithProject();
    await ProjectService.secret(project.secret);
    await ProjectService.public(project.public);

    const regenerated = await prisma.project.update({
      where: {id: project.id},
      data: {secret: newKey('sk'), public: newKey('pk')},
    });
    await ProjectService.invalidate(project, regenerated);

    expect(await ProjectService.secret(project.secret)).toBeNull();
    expect(await ProjectService.public(project.public)).toBeNull();
    expect((await ProjectService.secret(regenerated.secret))?.id).toBe(project.id);
  });

  it('only logs when the cache cannot be dropped', async () => {
    vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('Redis is down'));

    await expect(ProjectService.invalidate({id: 'p', secret: 's', public: 'k'})).resolves.toBeUndefined();
  });

  it('answers even when the cache cannot be written (Redis full)', async () => {
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('OOM command not allowed'));

    await expect(wrapRedis(`test:${randomBytes(4).toString('hex')}`, async () => ({ok: true}))).resolves.toEqual({
      ok: true,
    });
  });
});

describe('API key format', () => {
  function run(authorization: string): Promise<unknown> {
    const req = {method: 'POST', headers: {authorization}} as unknown as Request;
    return new Promise(resolve => {
      void requireSecretKey(req, {locals: {}} as Response, resolve as NextFunction);
    });
  }

  beforeEach(() => {
    vi.spyOn(ProjectService, 'secret');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['sk_', 'sk_short', `sk_${'a'.repeat(200)}`, 'sk_bad<key>12', 'xx_0123456789abcdef', "sk_';DROP-TABLE"])(
    'refuses %s as an invalid key without looking it up',
    async key => {
      expect(await run(`Bearer ${key}`)).toEqual(
        expect.objectContaining({code: 401, errorCode: ErrorCode.INVALID_API_KEY}),
      );
      expect(ProjectService.secret).not.toHaveBeenCalled();
    },
  );

  it('looks up a key with the right shape', async () => {
    const {project} = await factories.createUserWithProject();

    expect(await run(`Bearer ${project.secret}`)).toBeUndefined();
    expect(ProjectService.secret).toHaveBeenCalledWith(project.secret);
  });
});
