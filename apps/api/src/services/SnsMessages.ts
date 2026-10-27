import signale from 'signale';

import {redis} from '../database/redis.js';

/**
 * Plunk Lite: SNS messages the webhook has already handled, by their `MessageId`. SNS delivers at
 * least once -- again after a timeout, or from the dead-letter queue days later -- and an open, a
 * click or a delivery is not idempotent: each copy would count again and start the workflows
 * waiting for it again. Bounces and complaints need none of this, as recording them is claimed on
 * the email row.
 */

const KEY = (messageId: string) => `plunk-lite:sns:msg:${messageId}`;
// Long enough for any one request to finish; a crash mid-way frees the message after this
const BUSY_SECONDS = 120;
// SNS's own retries end well within a day. A copy from the dead-letter queue after that is handled
// again, the price of keeping Redis small: a key per open, click and delivery.
const DONE_SECONDS = 86400;

/** The SES events that count again with every copy, and so are handled once per SNS message */
const DEDUPLICATED_EVENTS = new Set(['Open', 'Click', 'Delivery', 'Received']);

/** `new`: handle it; `seen`: already handled; `busy`: another copy is being handled right now */
export type SnsMessageClaim = 'new' | 'seen' | 'busy';

export class SnsMessages {
  public static deduplicates(eventType: string): boolean {
    return DEDUPLICATED_EVENTS.has(eventType);
  }

  /**
   * Claims a message for this request. If Redis cannot answer the message is handled anyway: a
   * count twice beats an event lost.
   */
  public static async claim(messageId: string): Promise<SnsMessageClaim> {
    try {
      if (await redis.set(KEY(messageId), 'busy', 'EX', BUSY_SECONDS, 'NX')) {
        return 'new';
      }
      return (await redis.get(KEY(messageId))) === 'done' ? 'seen' : 'busy';
    } catch (error) {
      signale.warn(`[WEBHOOK] Could not check whether SNS message ${messageId} was handled:`, error);
      return 'new';
    }
  }

  /**
   * Once the request is answered: a message handled is kept as done, one that failed is given back
   * so the copy SNS sends next is handled. Never throws.
   */
  public static async settle(messageId: string, handled: boolean): Promise<void> {
    try {
      if (handled) {
        await redis.set(KEY(messageId), 'done', 'EX', DONE_SECONDS);
      } else {
        await redis.del(KEY(messageId));
      }
    } catch (error) {
      signale.warn(`[WEBHOOK] Could not settle SNS message ${messageId}:`, error);
    }
  }
}
