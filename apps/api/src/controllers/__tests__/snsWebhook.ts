import type {Request, Response} from 'express';

import {Webhooks} from '../Webhooks';

/**
 * Posting to the SNS webhook from a test, shared by the Webhooks.*.test.ts files. Each of them
 * mocks `getAwsAccountId` to resolve to the account of OWN_TOPIC.
 */

export const OWN_TOPIC = 'arn:aws:sns:eu-north-1:111111111111:plunk-ses-events';
export const FOREIGN_TOPIC = 'arn:aws:sns:eu-north-1:999999999999:plunk-ses-events';

/**
 * Minimal Express response double.
 *
 * `sent` is the completion signal and tests must await it rather than the handler call: the
 * `CatchAsync` decorator does not return the promise it creates, so awaiting a decorated
 * method resolves before any of its async work has run.
 */
export function mockResponse() {
  const captured = {status: 200, body: undefined as unknown};

  let markSent: () => void;
  const sent = new Promise<void>(resolve => {
    markSent = resolve;
  });

  const res = {
    statusCode: 200,
    status(code: number) {
      captured.status = code;
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      markSent();
      return this;
    },
  } as unknown as Response;

  return {res, captured, sent};
}

/** Deliver one SNS message as posted to the webhook, and wait for the answer */
export async function postSns(body: Record<string, unknown>) {
  const {res, captured, sent} = mockResponse();
  const req = {body, get: () => undefined, headers: {}} as unknown as Request;

  await new Webhooks().receiveSNSWebhook(req, res);
  await sent;

  return captured;
}

/** Deliver one SES event notification, shaped the way SNS posts it. */
export async function post(event: Record<string, unknown>, topicArn = OWN_TOPIC) {
  return postSns({Type: 'Notification', TopicArn: topicArn, Message: JSON.stringify(event)});
}

export const notification = (eventType: string, messageId: string, extra: Record<string, unknown> = {}) => ({
  eventType,
  mail: {messageId, timestamp: new Date().toISOString()},
  ...extra,
});
