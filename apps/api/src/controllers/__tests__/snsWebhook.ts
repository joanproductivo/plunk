import {invokeHandler} from '../../utils/invokeHandler';
import {Webhooks} from '../Webhooks';

/**
 * Posting to the SNS webhook from a test, shared by the Webhooks.*.test.ts files. Each of them
 * mocks `getAwsAccountId` to resolve to the account of OWN_TOPIC.
 */

export const OWN_TOPIC = 'arn:aws:sns:eu-north-1:111111111111:plunk-ses-events';
export const FOREIGN_TOPIC = 'arn:aws:sns:eu-north-1:999999999999:plunk-ses-events';

/** Deliver one SNS message as posted to the webhook, and wait for the answer */
export function postSns(body: Record<string, unknown>) {
  const webhooks = new Webhooks();
  return invokeHandler(webhooks.receiveSNSWebhook.bind(webhooks), body);
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
