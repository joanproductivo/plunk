/**
 * Contact subscription types
 */

import type {Contact} from '@plunk/db';

/**
 * How long a recipient asked to stop receiving email for.
 *
 * A fixed set rather than an arbitrary date because the endpoint that accepts it is
 * unauthenticated -- the recipient-facing snooze page -- so the range of states a stranger
 * can put a contact into stays small and reviewable. Operators who need an arbitrary date
 * resubscribe or unsubscribe through the authenticated API instead.
 *
 * Values are the wire format: they appear in the request body, in the `duration` field of the
 * `contact.unsubscribed` event, and as i18n key suffixes (`pages.snooze.duration.<value>`).
 */
export const SNOOZE_DURATIONS = ['2_weeks', '1_month', '6_months', '1_year'] as const;

export type SnoozeDuration = (typeof SNOOZE_DURATIONS)[number];

/**
 * Why a contact's subscription changed, carried on the `data` of the resulting
 * `contact.subscribed` / `contact.unsubscribed` event.
 *
 * Snoozing deliberately reuses those two events rather than introducing new names: workflows,
 * `WAIT_FOR_EVENT` steps, the activity feed and the campaign opt-out counters all read them
 * already, and a sender who wants to treat a snooze differently branches on this field.
 *
 * `bounce` and `complaint` are written by the SES webhook (Plunk Lite: on the `contact.unsubscribed`
 * tracked after the bounce or complaint, when it took the contact off the list).
 */
export type SubscriptionChangeReason = 'bounce' | 'complaint' | 'snooze' | 'snooze_expired';

/**
 * The subscription states the dashboard shows and filters on.
 *
 * Derived, not stored: `snoozed` is `subscribed = false` with a `snoozedUntil` set.
 * Storing it would mean a third state every send path had to learn about.
 */
export const CONTACT_SUBSCRIPTION_STATUSES = ['subscribed', 'snoozed', 'unsubscribed'] as const;

export type ContactSubscriptionStatus = (typeof CONTACT_SUBSCRIPTION_STATUSES)[number];

/**
 * How a contact's subscription state reads, wherever it is reported (the dashboard, the CSV export).
 *
 * `snoozed` is derived rather than stored: a snooze is `subscribed = false` plus a date, which
 * is what lets every send path suppress a snoozed contact through the `subscribed` filter it
 * already has. The cost of that is exactly this -- the two "not subscribed" states look
 * identical until you check the date, so every surface that reports status has to go through
 * here rather than branching on the boolean.
 */
export function contactStatus(contact: Pick<Contact, 'subscribed' | 'snoozedUntil'>): ContactSubscriptionStatus {
  if (contact.subscribed) {
    return 'subscribed';
  }

  return contact.snoozedUntil ? 'snoozed' : 'unsubscribed';
}

/** Why an address is on the project's suppression list (Plunk Lite) */
export type SuppressionReason = 'BOUNCE' | 'COMPLAINT';

/**
 * A contact address on the project's suppression list (Plunk Lite): it is never sent to, and
 * only the contact page or its owner, from an email they received, can subscribe it again
 */
export interface ContactSuppression<TDate = Date> {
  reason: SuppressionReason;
  createdAt: TDate;
}
