import {SNOOZE_DURATIONS, type SnoozeDuration} from '@plunk/types';
import type {Translator} from '@plunk/shared';

/**
 * Shared pieces of the recipient-facing snooze UI, used by both `/unsubscribe/[id]` and
 * `/manage/[id]` so the two surfaces cannot drift apart in wording or ordering.
 */

export interface ContactInfo {
  id: string;
  email: string;
  subscribed: boolean;
  /** ISO date while a snooze is running; null for a plain subscribe/unsubscribe state. */
  snoozedUntil: string | null;
  /** The sender's project name, printed inside the page copy ("emails from {projectName}"). */
  projectName: string;
  language: string;
  /** Plunk Lite: a subscribe answered with a confirmation email to click first (double opt-in) */
  pendingConfirmation?: boolean;
}

/**
 * Is this contact paused rather than gone?
 *
 * Both states are `subscribed: false` -- the whole point of the design is that the send paths
 * cannot tell them apart -- so the date is the only thing that distinguishes them, and every
 * piece of copy that says "unsubscribed" has to check it first.
 */
export function isSnoozed(contact: Pick<ContactInfo, 'subscribed' | 'snoozedUntil'> | null): boolean {
  return !!contact && !contact.subscribed && !!contact.snoozedUntil;
}

/**
 * The durations offered, in the order they are shown. Ordered shortest-first so the least
 * drastic option is the one nearest the recipient's cursor.
 */
export const SNOOZE_OPTIONS: readonly SnoozeDuration[] = SNOOZE_DURATIONS;

/** Label for a duration, from the contact's locale. */
export function snoozeDurationLabel(translator: Translator, duration: SnoozeDuration): string {
  return translator.t(`pages.snooze.duration_${duration}`);
}

/**
 * Format a snooze end date for a recipient.
 *
 * Uses `Intl` in the contact's own language rather than a fixed pattern, because this date is
 * the one piece of the page a recipient actually has to act on -- "11 March 2027" and
 * "March 11, 2027" and "2027年3月11日" are the same day, and only one of them reads as a date
 * to any given person. Falls back to the browser default if the language tag is unusable.
 */
export function formatSnoozeDate(value: string | null, language: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const options: Intl.DateTimeFormatOptions = {year: 'numeric', month: 'long', day: 'numeric'};

  try {
    return new Intl.DateTimeFormat(language, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}
