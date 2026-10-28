import {describe, expect, it} from 'vitest';

import {signWebhook} from '../webhookSignature.js';

/**
 * Plunk Lite: the X-Plunk-Signature a webhook receiver checks. The expected values were computed
 * apart, with `printf '%s' '<t>.<body>' | openssl dgst -sha256 -hmac <secret>`.
 */
describe('signWebhook', () => {
  const secret = 's'.repeat(32);
  const now = 1761620000123;

  it('signs "<t>.<body>" in whole seconds, as hex', () => {
    expect(signWebhook(secret, '{"msg":"ñandú 🌴","email":"a@b.c"}', now)).toBe(
      't=1761620000,v1=505dc488d296d371b56169b82b5f674f3d7f493de0269f3a31360a54fbbdb584',
    );
  });

  it('signs "<t>." when there is no body', () => {
    expect(signWebhook(secret, '', now)).toBe(
      't=1761620000,v1=abb88fa7738afc93907aae657efd914cfb3b2810d424dcdac5ea0f2f291b39cd',
    );
  });
});
