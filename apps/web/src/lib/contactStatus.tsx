import type {Contact} from '@plunk/db';
import {contactStatus, type ContactSubscriptionStatus} from '@plunk/types';
import {Badge} from '@plunk/ui';
import {Clock, MailCheck, MailX} from 'lucide-react';
import React from 'react';

/**
 * Absolute date for a snooze end, in the operator's locale.
 *
 * Deliberately not a relative time like the neighbouring `createdAt` column. "In 5 months" is
 * fine for something that already happened, but the one question an operator has about a
 * snoozed contact is *when do they come back*, and that answer has to be a date they can put in
 * a calendar.
 */
export function formatSnoozedUntil(value: Date | string | null): string {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric'}).format(date);
}

const STATUS_LABEL: Record<ContactSubscriptionStatus, string> = {
  subscribed: 'Subscribed',
  snoozed: 'Snoozed',
  unsubscribed: 'Unsubscribed',
};

/**
 * The status badge, shared by the table and card views of the contacts list so the two cannot
 * disagree. Snoozed takes a neutral fill rather than a red one: the contact is coming back, and
 * colouring it like a loss would misreport the list's health.
 */
export function ContactStatusBadge({contact}: {contact: Pick<Contact, 'subscribed' | 'snoozedUntil'>}) {
  const status = contactStatus(contact);

  return (
    <Badge
      variant={status === 'subscribed' ? 'success' : status === 'snoozed' ? 'neutral' : 'destructive'}
      title={status === 'snoozed' ? `Resumes on ${formatSnoozedUntil(contact.snoozedUntil)}` : undefined}
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** The matching icon shown beside the email address. */
export function ContactStatusIcon({contact}: {contact: Pick<Contact, 'subscribed' | 'snoozedUntil'>}) {
  const status = contactStatus(contact);

  if (status === 'subscribed') {
    return <MailCheck className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />;
  }

  if (status === 'snoozed') {
    return <Clock className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />;
  }

  return <MailX className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />;
}
