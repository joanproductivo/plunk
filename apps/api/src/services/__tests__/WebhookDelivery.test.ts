import {describe, expect, it} from 'vitest';

import {
  describeNetworkError,
  isTransientNetworkError,
  isTransientStatus,
  toDeliveryError,
  WebhookTransientError,
} from '../WebhookDelivery';

const HOST = 'club.example.com';

const connectionError = (code: string, address: string, port = 443) =>
  Object.assign(new Error('x'), {code, address, port});

/** A failed fetch as Node reports it, with its message as fetch words it */
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', {cause});

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'});

describe('WebhookDelivery', () => {
  describe('the failure of 2026-10-30: one address too slow, the next failing at once', () => {
    const error = fetchFailed(
      Object.assign(
        new AggregateError([
          connectionError('ETIMEDOUT', '188.114.96.5'),
          connectionError('ENETUNREACH', '2606:4700::1'),
        ]),
        {code: 'ETIMEDOUT'},
      ),
    );

    it('is worth another attempt', () => {
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it('says what happened to each address', () => {
      expect(describeNetworkError(error, HOST)).toBe(
        `Connection to ${HOST} failed: ETIMEDOUT 188.114.96.5:443, ENETUNREACH [2606:4700::1]:443`,
      );
    });
  });

  describe('isTransientNetworkError', () => {
    it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET'])(
      'repeats %s',
      code => {
        expect(isTransientNetworkError(fetchFailed(Object.assign(new Error('x'), {code})))).toBe(true);
      },
    );

    it('repeats a timeout and a DNS lookup that could not answer', () => {
      expect(isTransientNetworkError(timeout())).toBe(true);
      expect(isTransientNetworkError(Object.assign(new Error('getaddrinfo'), {code: 'EAI_AGAIN'}))).toBe(true);
    });

    it('does not repeat what would fail the same forever', () => {
      expect(isTransientNetworkError(Object.assign(new Error('getaddrinfo'), {code: 'ENOTFOUND'}))).toBe(false);
      expect(isTransientNetworkError(fetchFailed(Object.assign(new Error('x'), {code: 'CERT_HAS_EXPIRED'})))).toBe(
        false,
      );
      expect(isTransientNetworkError(fetchFailed(new Error('bad port')))).toBe(false);
      expect(isTransientNetworkError(new TypeError('Request cannot be constructed'))).toBe(false);
    });
  });

  describe('describeNetworkError', () => {
    it('names a timeout and a DNS failure', () => {
      expect(describeNetworkError(timeout(), HOST)).toBe(`Timed out after 10 s waiting for ${HOST}`);
      expect(describeNetworkError(Object.assign(new Error('x'), {code: 'EAI_AGAIN'}), HOST)).toBe(
        `DNS lookup failed for ${HOST}: EAI_AGAIN`,
      );
    });

    it('names another failure by its code', () => {
      expect(describeNetworkError(fetchFailed(Object.assign(new Error('x'), {code: 'CERT_HAS_EXPIRED'})), HOST)).toBe(
        `Connection to ${HOST} failed: CERT_HAS_EXPIRED`,
      );
    });

    // The URL of a webhook can carry a token; fetch quotes it in these messages
    it.each([
      [
        'a URL with credentials',
        'Request cannot be constructed from a URL that includes credentials: https://u:s3cret@h/hook/TOKEN',
      ],
      ['an invalid header', 'Headers.append: "line-SECRET" is an invalid header value.'],
    ])('never repeats the message of fetch for %s', (_name, message) => {
      const description = describeNetworkError(new TypeError(message), HOST);

      expect(description).toBe(`Request to ${HOST} could not be sent (TypeError)`);
      expect(description).not.toMatch(/TOKEN|SECRET|s3cret/);
    });
  });

  describe('isTransientStatus', () => {
    it.each([408, 425, 429, 500, 502, 503, 504])('repeats %i', status => {
      expect(isTransientStatus(status)).toBe(true);
    });

    it.each([400, 401, 403, 404, 410, 422])('does not repeat %i', status => {
      expect(isTransientStatus(status)).toBe(false);
    });
  });

  describe('toDeliveryError', () => {
    it('marks only what is worth repeating', () => {
      expect(toDeliveryError(timeout(), HOST)).toBeInstanceOf(WebhookTransientError);
      expect(toDeliveryError(new TypeError('x'), HOST)).not.toBeInstanceOf(WebhookTransientError);
    });
  });
});
