import {createHmac} from 'node:crypto';

/** Plunk Lite: the header a signed webhook request carries */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Plunk-Signature';

/**
 * Plunk Lite: `t=<unix seconds>,v1=<hex HMAC-SHA256>` over `<t>.<body>`, with the body exactly as
 * it is sent (an empty string when there is none). The receiver recomputes it over the raw bytes
 * it got, and rejects a `t` too far from its own clock.
 */
export function signWebhook(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}
