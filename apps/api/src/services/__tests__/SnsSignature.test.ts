import {afterEach, describe, expect, it, vi} from 'vitest';

import {SnsSignature} from '../SnsSignature';

let certNumber = 0;

// Each case its own certificate URL: a fetched certificate is cached by URL
const notification = (
  certUrl = `https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-${++certNumber}.pem`,
) => ({
  Type: 'Notification',
  Message: '{}',
  MessageId: 'message-1',
  Timestamp: '2026-10-27T00:00:00.000Z',
  TopicArn: 'arn:aws:sns:eu-north-1:123456789012:plunk-ses-events',
  SignatureVersion: '1',
  Signature: 'c2lnbmF0dXJl',
  SigningCertURL: certUrl,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Whether a signature check failed because the signing certificate could not be fetched
 * ('unavailable', answered 503 so SNS delivers again) or because it cannot be valid ('invalid',
 * answered 403). Only an answer from the certificate host makes a signature invalid.
 */
describe('SnsSignature.verify - fetching the signing certificate', () => {
  it.each([
    ['the network fails', () => Promise.reject(new TypeError('fetch failed'))],
    ['the request times out', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['the host answers 503', () => Promise.resolve(new Response('busy', {status: 503}))],
    [
      'the body cannot be read',
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.reject(new Error('socket hang up')),
        } as unknown as Response),
    ],
  ])('is unavailable when %s', async (_case, fetchImpl) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));

    expect(await SnsSignature.verify(notification())).toBe('unavailable');
  });

  it('is invalid when the host answers that the certificate does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', {status: 404, statusText: 'Not Found'}))),
    );

    expect(await SnsSignature.verify(notification())).toBe('invalid');
  });
});

/**
 * The certificate URL comes from the message, so anyone can post one. Only the URLs AWS signs
 * with are fetched, and only so many certificates are kept.
 */
describe('SnsSignature.verify - which certificate URLs are fetched', () => {
  it.each([
    ['a query', 'https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem?x=1'],
    ['a fragment', 'https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem#x'],
    ['credentials', 'https://user:pass@sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a port', 'https://sns.eu-north-1.amazonaws.com:8443/SimpleNotificationService-abc.pem'],
    ['a path that is not an SNS .pem', 'https://sns.eu-north-1.amazonaws.com/other/file.pem'],
    ['a path under the .pem', 'https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem/x'],
    ['another host', 'https://example.com/SimpleNotificationService-abc.pem'],
    ['plain http', 'http://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem'],
  ])('rejects a URL with %s without requesting it', async (_case, certUrl) => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('pem')));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await SnsSignature.verify(notification(certUrl))).toBe('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps at most 20 certificates, dropping the oldest first', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('not a certificate')));
    vi.stubGlobal('fetch', fetchSpy);
    const urls = Array.from(
      {length: 21},
      (_, i) => `https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-cap${i}.pem`,
    );

    for (const url of urls) {
      await SnsSignature.verify(notification(url));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(21);

    // The latest is still cached; the first one was dropped and is fetched again
    await SnsSignature.verify(notification(urls[20]));
    expect(fetchSpy).toHaveBeenCalledTimes(21);
    await SnsSignature.verify(notification(urls[0]));
    expect(fetchSpy).toHaveBeenCalledTimes(22);
  });
});
