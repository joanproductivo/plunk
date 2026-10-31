import {Button, IconSpinner} from '@plunk/ui';
import {Check, MailCheck} from 'lucide-react';
import {useRouter} from 'next/router';
import React, {useState} from 'react';

import {
  CardIntro,
  ErrorCard,
  InlineError,
  LoadingCard,
  RecipientShell,
  ResultState,
  RichText,
  useRecipient,
} from '../../components/list-management/ListManagement';
import {network} from '../../lib/network';
import type {ContactInfo} from '../../lib/snooze';
import {sourceEmailQuery} from '../../lib/sourceEmail';

export default function Subscribe() {
  const router = useRouter();
  const {id} = router.query;
  const {state, updateContact} = useRecipient(id);

  const [subscribing, setSubscribing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <RecipientShell page="subscribe" loading>
        <LoadingCard />
      </RecipientShell>
    );
  }

  if (state.status === 'error') {
    return (
      <RecipientShell page="subscribe" translator={state.translator}>
        <ErrorCard translator={state.translator} message={state.message} />
      </RecipientShell>
    );
  }

  const {contact, translator} = state;

  const handleSubscribe = async () => {
    try {
      setSubscribing(true);
      setActionError(null);
      const data = await network.fetch<ContactInfo>(
        'POST',
        `/contacts/public/${id as string}/subscribe${sourceEmailQuery(router.query)}`,
      );
      updateContact({pendingConfirmation: false, ...data});
    } catch (error) {
      // Translated copy rather than the server's English message; see useRecipient. An address
      // suppressed after a bounce or complaint is only resubscribed from an email's own link.
      setActionError(
        translator.t(
          // Plunk Lite: so is one the double opt-in will not ask to confirm from here
          ['ADDRESS_SUPPRESSED', 'CONFIRMATION_NEEDS_EMAIL'].includes((error as {code?: string}).code ?? '')
            ? 'pages.common.resubscribeNeedsEmail'
            : 'pages.common.actionFailed',
        ),
      );
    } finally {
      setSubscribing(false);
    }
  };

  // Plunk Lite: with the double opt-in on, the address confirms from the email just sent to it
  if (contact.pendingConfirmation) {
    return (
      <RecipientShell page="subscribe" translator={translator}>
        <ResultState icon={MailCheck} title={translator.t('pages.subscribe.pendingTitle')}>
          <RichText
            template={translator.t('pages.subscribe.pendingDescription')}
            values={{projectName: contact.projectName, email: contact.email}}
          />
        </ResultState>
      </RecipientShell>
    );
  }

  if (contact.subscribed) {
    return (
      <RecipientShell page="subscribe" translator={translator}>
        <ResultState icon={Check} title={translator.t('pages.subscribe.successTitle')}>
          <RichText template={translator.t('pages.subscribe.successDescription')} values={{projectName: contact.projectName, email: contact.email}} />
        </ResultState>
      </RecipientShell>
    );
  }

  return (
    <RecipientShell page="subscribe" translator={translator}>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <CardIntro title={translator.t('pages.subscribe.title')}>
          <RichText template={translator.t('pages.subscribe.description')} values={{projectName: contact.projectName, email: contact.email}} />
        </CardIntro>

        <InlineError message={actionError} />

        <Button
          size="lg"
          className="w-full"
          disabled={subscribing}
          aria-busy={subscribing || undefined}
          onClick={() => void handleSubscribe()}
        >
          {subscribing ? (
            <>
              <IconSpinner size="sm" />
              {translator.t('pages.subscribe.buttonLoading')}
            </>
          ) : (
            translator.t('pages.subscribe.button')
          )}
        </Button>
      </div>
    </RecipientShell>
  );
}
