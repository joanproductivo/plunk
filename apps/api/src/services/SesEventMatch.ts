import signale from 'signale';
import {z} from 'zod';

import {redis} from '../database/redis.js';

import {FailureAlertService} from './FailureAlertService.js';

/**
 * Plunk Lite: reading what SNS delivers to the SES webhook, and the trouble with it that no single
 * email shows -- a message that cannot be read, a run of rejected deliveries.
 */

/** The SES notifications the webhook handles; anything else is acknowledged and left alone */
const SES_EVENT_TYPES = ['Bounce', 'Complaint', 'Delivery', 'Open', 'Click', 'Received'] as const;
export type SesEventType = (typeof SES_EVENT_TYPES)[number];

/**
 * What every handled notification must carry. Only the message id is required: the other fields
 * are read when they are there and ignored when they are not the expected shape, so an odd field
 * cannot lose a bounce.
 */
const sesMessageSchema = z
  .object({
    mail: z
      .object({
        messageId: z.string().min(1),
        timestamp: z.string().optional().catch(undefined),
        destination: z.array(z.string()).optional().catch(undefined),
        source: z.string().optional().catch(undefined),
        tags: z.record(z.unknown()).optional().catch(undefined),
      })
      .passthrough(),
  })
  .passthrough();

export type SesMail = z.infer<typeof sesMessageSchema>['mail'];

export type SesNotification =
  | {kind: 'event'; eventType: SesEventType; mail: SesMail}
  // A notification of a type the webhook does not handle, such as SES's own test message
  | {kind: 'other'; type: unknown}
  | {kind: 'invalid'; reason: string};

/** The `Message` of an SNS notification, parsed; undefined when it is not JSON */
export function parseSnsMessage(message: unknown) {
  if (typeof message !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}

/**
 * What an SES notification is. Event publishing names its type `eventType`; identity notifications
 * and inbound mail name it `notificationType`.
 */
export function readSesNotification(body: unknown): SesNotification {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const type = fields.eventType ?? fields.notificationType;
  if (!SES_EVENT_TYPES.includes(type as SesEventType)) {
    return {kind: 'other', type};
  }

  const parsed = sesMessageSchema.safeParse(body);
  if (!parsed.success) {
    return {kind: 'invalid', reason: `${String(type)} notification without a message id`};
  }
  return {kind: 'event', eventType: type as SesEventType, mail: parsed.data.mail};
}

/**
 * A notification from this installation's own topic, with a valid signature, that cannot be read.
 * Delivering it again would not change it, so it is acknowledged; every project hears about it,
 * since nothing says which one it was for.
 */
export async function reportUnreadable(reason: string): Promise<void> {
  signale.error(`[WEBHOOK] SES notification dropped, it cannot be read: ${reason}`);
  await FailureAlertService.recordForAll({
    sourceKey: 'sns:invalid',
    label: 'Unreadable SES events',
    error: `A signed SES notification from this installation's topic could not be read (${reason}), so the bounce, complaint or delivery it reported was not recorded.`,
  });
}

/** Why the webhook turned an SNS delivery away */
export type SnsRejection = 'signature' | 'topic';

/**
 * Deliveries the webhook rejected, kept for the check of the event pipeline: when each reason was
 * last seen (`SNS_REJECTS_KEY`, reason → time) and how many there were each hour
 * (`snsRejectsHourKey(hour)`, reason → count). Nothing is alerted from here, since anyone can post
 * a rejected delivery.
 */
export const SNS_REJECTS_KEY = 'plunk-lite:sns:rejects';
export const snsRejectsHourKey = (hour: string) => `plunk-lite:sns:rejects:${hour}`;
const REJECTS_SECONDS = 7 * 86400;
const REJECTS_HOUR_SECONDS = 48 * 3600;

export async function noteSnsRejection(reason: SnsRejection): Promise<void> {
  const now = new Date().toISOString();
  const hourKey = snsRejectsHourKey(now.slice(0, 13));
  try {
    await redis
      .multi()
      .hset(SNS_REJECTS_KEY, reason, now)
      .expire(SNS_REJECTS_KEY, REJECTS_SECONDS)
      .hincrby(hourKey, reason, 1)
      .expire(hourKey, REJECTS_HOUR_SECONDS)
      .exec();
  } catch (error) {
    signale.warn(`[WEBHOOK] Could not note an SNS delivery rejected for its ${reason}:`, error);
  }
}
