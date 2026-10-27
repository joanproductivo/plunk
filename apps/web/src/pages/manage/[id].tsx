import {ContactSchemas} from '@plunk/shared';
import type {SnoozeDuration} from '@plunk/types';
import {IconSpinner, Label, Switch} from '@plunk/ui';
import {useRouter} from 'next/router';
import React, {useId, useState} from 'react';

import {
  CardIntro,
  ErrorCard,
  InlineError,
  LoadingCard,
  RecipientShell,
  RichText,
  SnoozePicker,
  useRecipient,
} from '../../components/list-management/ListManagement';
import {network} from '../../lib/network';
import {type ContactInfo, formatSnoozeDate, isSnoozed} from '../../lib/snooze';
import {sourceEmailQuery} from '../../lib/sourceEmail';

/**
 * The preference center.
 *
 * One control per decision. The subscription switch is the whole on/off state -- including
 * ending a snooze early, which is just switching back on -- so this page no longer repeats it
 * with "Unsubscribe completely" / "Subscribe to emails" buttons that did the same thing.
 */
export default function Manage() {
  const router = useRouter();
  const {id} = router.query;
  const {state, updateContact} = useRecipient(id);
  const switchId = useId();
  const statusId = useId();

  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <RecipientShell page="manage" loading>
        <LoadingCard />
      </RecipientShell>
    );
  }

  if (state.status === 'error') {
    return (
      <RecipientShell page="manage" translator={state.translator}>
        <ErrorCard translator={state.translator} message={state.message} />
      </RecipientShell>
    );
  }

  const {contact, translator} = state;
  const snoozed = isSnoozed(contact);

  const handleToggle = async (next: boolean) => {
    try {
      setUpdating(true);
      setActionError(null);
      const data = await network.fetch<ContactInfo>(
        'POST',
        `/contacts/public/${id as string}/${next ? 'subscribe' : 'unsubscribe'}${sourceEmailQuery(router.query)}`,
      );
      updateContact(data);
    } catch (error) {
      // Translated copy rather than the server's English message; see useRecipient. An address
      // suppressed after a bounce or complaint is only resubscribed from an email's own link.
      setActionError(
        translator.t(
          (error as {code?: string}).code === 'ADDRESS_SUPPRESSED'
            ? 'pages.common.resubscribeNeedsEmail'
            : 'pages.common.actionFailed',
        ),
      );
    } finally {
      setUpdating(false);
    }
  };

  const handleSnooze = async (duration: SnoozeDuration) => {
    try {
      setActionError(null);
      const data = await network.fetch<ContactInfo, typeof ContactSchemas.snooze>(
        'POST',
        `/contacts/public/${id as string}/snooze${sourceEmailQuery(router.query)}`,
        {duration},
      );
      updateContact(data);
    } catch {
      // Translated copy rather than the server's English message; see useRecipient.
      setActionError(translator.t('pages.common.actionFailed'));
    }
  };

  // Three states behind a two-state switch. A snoozed contact is `subscribed: false`, but
  // "you are unsubscribed" would be false -- they paused, and the date is what they need.
  const statusText = contact.subscribed
    ? translator.t('pages.manage.subscribedStatus')
    : snoozed
      ? translator.t('pages.snooze.status', {date: formatSnoozeDate(contact.snoozedUntil, contact.language)})
      : translator.t('pages.manage.unsubscribedStatus');

  return (
    <RecipientShell page="manage" translator={translator}>
      <div className="flex flex-col gap-6 p-6 pb-5 sm:p-8 sm:pb-6">
        <CardIntro title={translator.t('pages.manage.title')}>
          <RichText template={translator.t('pages.manage.description')} values={{projectName: contact.projectName, email: contact.email}} />
        </CardIntro>
        <InlineError message={actionError} />
      </div>

      {/* Settings rows run edge to edge, divided by rules, rather than sitting in a box inside the card. */}
      <div className="divide-y divide-neutral-200 border-t border-neutral-200">
        <div className="flex items-center justify-between gap-6 px-6 py-5 sm:px-8">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={switchId} className="text-sm font-medium text-neutral-900">
              {translator.t('pages.manage.subscriptionLabel')}
            </Label>
            {/* Live, so the change a switch makes is announced, not only drawn. */}
            <p id={statusId} aria-live="polite" className="text-sm text-neutral-600">
              {statusText}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {updating ? <IconSpinner size="sm" /> : null}
            <Switch
              id={switchId}
              checked={contact.subscribed}
              disabled={updating}
              aria-describedby={statusId}
              onCheckedChange={next => void handleToggle(next)}
            />
          </div>
        </div>

        {contact.subscribed ? (
          <div className="px-6 py-4 sm:px-8">
            <SnoozePicker translator={translator} onSnooze={handleSnooze} disabled={updating} align="start" />
          </div>
        ) : null}
      </div>
    </RecipientShell>
  );
}
