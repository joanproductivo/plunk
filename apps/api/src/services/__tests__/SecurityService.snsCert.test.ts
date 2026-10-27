import {afterEach, describe, expect, it, vi} from 'vitest';

import {SecurityService} from '../SecurityService';

/**
 * Whether a signature check failed because the signing certificate could not be fetched
 * ('unavailable', answered 503 so SNS delivers again) or because it cannot be valid ('invalid',
 * answered 403). Only an answer from the certificate host makes a signature invalid.
 */
describe('SecurityService.verifySnsSignature - fetching the signing certificate', () => {
  let certNumber = 0;

  // Each case its own certificate URL: a fetched certificate is cached by URL
  const notification = () => ({
    Type: 'Notification',
    Message: '{}',
    MessageId: 'message-1',
    Timestamp: '2026-10-27T00:00:00.000Z',
    TopicArn: 'arn:aws:sns:eu-north-1:123456789012:plunk-ses-events',
    SignatureVersion: '1',
    Signature: 'c2lnbmF0dXJl',
    SigningCertURL: `https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-${++certNumber}.pem`,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    expect(await SecurityService.verifySnsSignature(notification())).toBe('unavailable');
  });

  it('is invalid when the host answers that the certificate does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', {status: 404, statusText: 'Not Found'}))),
    );

    expect(await SecurityService.verifySnsSignature(notification())).toBe('invalid');
  });
});
