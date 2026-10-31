import type {Contact} from '@plunk/db';
import {type ContactDisplayStatus, contactStatus} from '@plunk/types';
import {Badge} from '@plunk/ui';
import {Clock, MailCheck, MailQuestionMark, MailX} from 'lucide-react';
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

const STATUS_LABEL: Record<ContactDisplayStatus, string> = {
  subscribed: 'Subscribed',
  pending: 'Pending confirmation',
  snoozed: 'Snoozed',
  unsubscribed: 'Unsubscribed',
};

/** A contact as the list and its page read it: `pendingConfirmation` (Plunk Lite) from the API */
type StatusContact = Pick<Contact, 'subscribed' | 'snoozedUntil'> & {pendingConfirmation?: boolean};

/**
 * The status badge, shared by the table and card views of the contacts list so the two cannot
 * disagree. Snoozed takes a neutral fill rather than a red one: the contact is coming back, and
 * colouring it like a loss would misreport the list's health. A contact still to confirm a
 * sign-up (Plunk Lite) is amber: it asked to join and has not yet.
 */
export function ContactStatusBadge({contact}: {contact: StatusContact}) {
  const status = contactStatus(contact);

  return (
    <Badge
      variant={
        status === 'subscribed'
          ? 'success'
          : status === 'snoozed'
            ? 'neutral'
            : status === 'pending'
              ? 'warning'
              : 'destructive'
      }
      title={
        status === 'snoozed'
          ? `Resumes on ${formatSnoozedUntil(contact.snoozedUntil)}`
          : status === 'pending'
            ? 'Signed up, but has not yet clicked the link in the confirmation email'
            : undefined
      }
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** The matching icon shown beside the email address. */
export function ContactStatusIcon({contact}: {contact: StatusContact}) {
  const status = contactStatus(contact);

  if (status === 'subscribed') {
    return <MailCheck className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />;
  }

  if (status === 'pending') {
    return <MailQuestionMark className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />;
  }

  if (status === 'snoozed') {
    return <Clock className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />;
  }

  return <MailX className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />;
}
