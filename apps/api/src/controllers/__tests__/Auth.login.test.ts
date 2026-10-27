import type {NextFunction, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {LOGIN_RATE_LIMIT} from '../../app/constants';
import {redis} from '../../database/redis';
import {Keys} from '../../services/keys';
import {Auth} from '../Auth';
import {factories} from '../../../../../test/helpers';

/**
 * Password logins are limited per address, so passwords cannot be guessed without end
 */
describe('Auth.login - attempt limit', () => {
  const password = 'correct-password';
  let email: string;

  beforeEach(async () => {
    const user = await factories.createUser({password});
    email = user.email;
    await redis.del(Keys.User.loginRateLimit(email.toLowerCase()));
  });

  /** One login, resolved with the JSON it answered or the error it passed on */
  function login(body: {email: string; password: string}) {
    return new Promise<{json?: {success: unknown}; error?: {code?: number}}>(resolve => {
      const res = {
        cookie() {
          return this;
        },
        json(json: {success: unknown}) {
          resolve({json});
          return this;
        },
      } as unknown as Response;
      const next = ((error: {code?: number}) => resolve({error})) as NextFunction;

      void new Auth().login({body} as Request, res, next);
    });
  }


  it('refuses further attempts once the limit is reached, even with the right password', async () => {
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT; attempt++) {
      expect((await login({email, password: 'wrong-password'})).json?.success).toBe(false);
    }

    expect((await login({email, password})).error?.code).toBe(429);
  });

  it('counts attempts made at the same time one by one', async () => {
    const results = await Promise.all(
      Array.from({length: LOGIN_RATE_LIMIT + 5}, () => login({email, password: 'wrong-password'})),
    );

    expect(results.filter(result => result.error?.code === 429)).toHaveLength(5);
  });

  it('counts attempts at an address without an account the same way', async () => {
    const unknown = `nobody-${Date.now()}@test.com`;
    await redis.del(Keys.User.loginRateLimit(unknown));

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT; attempt++) {
      await login({email: unknown, password: 'wrong-password'});
    }

    expect((await login({email: unknown, password: 'wrong-password'})).error?.code).toBe(429);
  });

  it('starts the count again after a successful login', async () => {
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT - 1; attempt++) {
      await login({email, password: 'wrong-password'});
    }

    expect((await login({email, password})).json?.success).toBe(true);
    expect((await login({email, password: 'wrong-password'})).json?.success).toBe(false);
  });
});
