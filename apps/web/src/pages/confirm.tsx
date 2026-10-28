import {createTranslator, type OptInSchemas, type Translator} from '@plunk/shared';
import type {OptInLink} from '@plunk/types';
import {Button, IconSpinner} from '@plunk/ui';
import {AlertCircle, Check} from 'lucide-react';
import React, {useEffect, useState} from 'react';

import {
  browserLanguage,
  CardIntro,
  ErrorCard,
  InlineError,
  LoadingCard,
  RecipientShell,
  ResultState,
  RichText,
} from '../components/list-management/ListManagement';
import {network} from '../lib/network';

type PageState =
  | {status: 'loading'}
  | {status: 'error'; translator: Translator}
  | {status: 'ready'; link: OptInLink; translator: Translator};

/**
 * Plunk Lite: the page a double opt-in email links to, `/confirm#<token>`. The token comes after
 * the `#`, so it never reaches a server log, and goes to the API in a request body.
 *
 * Loading the page only reads the link; the sign-up is confirmed by pressing the button. Mail
 * scanners (Outlook Safe Links and the like) open every link in an email, and would otherwise
 * confirm addresses nobody confirmed.
 */
export default function Confirm() {
  const [state, setState] = useState<PageState>({status: 'loading'});
  const [token, setToken] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    setToken(fromHash);
    let cancelled = false;

    const load = async () => {
      try {
        const link = await network.fetch<OptInLink, typeof OptInSchemas.token>('POST', '/optin/describe', {
          token: fromHash,
        });
        const translator = await createTranslator(link.status === 'invalid' ? browserLanguage() : link.language);
        if (!cancelled) setState({status: 'ready', link, translator});
      } catch {
        const translator = await createTranslator(browserLanguage());
        if (!cancelled) setState({status: 'error', translator});
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <RecipientShell page="confirm" loading>
        <LoadingCard />
      </RecipientShell>
    );
  }

  const {translator} = state;

  if (state.status === 'error') {
    return (
      <RecipientShell page="confirm" translator={translator}>
        <ErrorCard translator={translator} message={translator.t('pages.common.loadFailed')} />
      </RecipientShell>
    );
  }

  const {link} = state;

  if (link.status === 'invalid') {
    return (
      <RecipientShell page="confirm" translator={translator}>
        <div className="flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-600/20 ring-inset">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
          </div>
          <CardIntro title={translator.t('pages.confirm.invalidTitle')}>
            {translator.t('pages.confirm.invalidDescription')}
          </CardIntro>
        </div>
      </RecipientShell>
    );
  }

  const values = {projectName: link.projectName, email: link.email};

  if (link.status === 'confirmed') {
    return (
      <RecipientShell page="confirm" translator={translator}>
        <ResultState icon={Check} title={translator.t('pages.confirm.successTitle')}>
          <RichText template={translator.t('pages.confirm.successDescription')} values={values} />
        </ResultState>
      </RecipientShell>
    );
  }

  const handleConfirm = async () => {
    try {
      setConfirming(true);
      setActionError(null);
      const {status} = await network.fetch<{status: 'confirmed' | 'invalid'}, typeof OptInSchemas.token>(
        'POST',
        '/optin/confirm',
        {token},
      );
      setState({status: 'ready', translator, link: status === 'confirmed' ? {...link, status} : {status}});
    } catch {
      // Translated copy rather than the server's English message; see useRecipient
      setActionError(translator.t('pages.common.actionFailed'));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <RecipientShell page="confirm" translator={translator}>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <CardIntro title={translator.t('pages.confirm.title')}>
          <RichText template={translator.t('pages.confirm.description')} values={values} />
        </CardIntro>

        <InlineError message={actionError} />

        <Button
          size="lg"
          className="w-full"
          disabled={confirming}
          aria-busy={confirming || undefined}
          onClick={() => void handleConfirm()}
        >
          {confirming ? (
            <>
              <IconSpinner size="sm" />
              {translator.t('pages.confirm.buttonLoading')}
            </>
          ) : (
            translator.t('pages.confirm.button')
          )}
        </Button>
      </div>
    </RecipientShell>
  );
}
