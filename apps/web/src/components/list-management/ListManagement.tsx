import {createTranslator, isValidLanguageCode, type Translator} from '@plunk/shared';
import type {SnoozeDuration} from '@plunk/types';
import {Button, Card, IconSpinner, Skeleton} from '@plunk/ui';
import {AlertCircle, Clock} from 'lucide-react';
import Image from 'next/image';
import React, {useEffect, useId, useRef, useState} from 'react';

import {LANDING_URI} from '../../lib/constants';
import {network} from '../../lib/network';
import {type ContactInfo, SNOOZE_OPTIONS, snoozeDurationLabel} from '../../lib/snooze';

/**
 * Shared pieces of the recipient-facing list-management pages: `/unsubscribe`, `/subscribe`
 * and `/manage`, and Plunk Lite's `/confirm`.
 *
 * These are the only Plunk surfaces a sender's recipients ever see, reached from a link in an
 * email with no account and no context. They share one shell so the three pages cannot drift
 * apart in layout, loading, error or confirmation treatment -- a recipient who moves between
 * them should feel they never left the page.
 */

type RecipientState =
  | {status: 'loading'}
  | {status: 'error'; message: string; translator: Translator}
  | {status: 'ready'; contact: ContactInfo; translator: Translator};

/**
 * Best guess at a recipient's language when the contact -- which normally carries it -- could
 * not be loaded. Tries the browser's preferred languages, exact tag first (`zh-HK`), then the
 * base language (`nl-BE` -> `nl`), and settles on English.
 */
export function browserLanguage(): string {
  if (typeof navigator === 'undefined') {
    return 'en';
  }

  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];

  for (const tag of preferred) {
    if (!tag) continue;
    if (isValidLanguageCode(tag)) return tag;
    const base = tag.split('-')[0];
    if (base && isValidLanguageCode(base)) return base;
  }

  return 'en';
}

/**
 * Load the contact and a translator for their language.
 *
 * The translator is loaded even when the contact is not: the language comes from the contact,
 * so a failed lookup used to leave the translator unset forever, and the page sat on its
 * loading state instead of ever reporting the error. A failure now falls back to the browser's
 * language.
 *
 * The error shown is always translated copy, never the server's message. Those are English
 * developer text ("Contact not found", "Failed to fetch") and mean nothing to a recipient
 * reading the page in Japanese.
 */
export function useRecipient(id: string | string[] | undefined) {
  const [state, setState] = useState<RecipientState>({status: 'loading'});

  useEffect(() => {
    if (!id || typeof id !== 'string') return;

    let cancelled = false;

    const load = async () => {
      try {
        const contact = await network.fetch<ContactInfo>('GET', `/contacts/public/${id}`);
        const translator = await createTranslator(contact.language || 'en');
        if (!cancelled) setState({status: 'ready', contact, translator});
      } catch {
        const translator = await createTranslator(browserLanguage());
        if (!cancelled) {
          setState({status: 'error', message: translator.t('pages.common.loadFailed'), translator});
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Replace the contact after an action, keeping fields the action response omits. */
  const updateContact = (next: Partial<ContactInfo>) => {
    setState(prev => (prev.status === 'ready' ? {...prev, contact: {...prev.contact, ...next}} : prev));
  };

  return {state, updateContact};
}

/**
 * Which hosted page a visitor followed the Plunk attribution from. Sent as `?ref=` on the link to
 * the marketing site, matching the `?ref=badge` the email footer badge uses, so each surface can
 * be told apart in analytics.
 */
export type RecipientPage = 'unsubscribe' | 'subscribe' | 'manage' | 'confirm';

/**
 * The page frame: dot-grid ground, a narrow centred column, the card, and the mail provider
 * below it.
 *
 * There is deliberately no sender header. The sender is named inside the copy ("Stop receiving
 * emails from Acme at ...") instead: a name on its own above the card is a branding slot, reads
 * as the page's owner, and invites the next request to put a logo in it. In a sentence it is
 * simply context.
 *
 * Scrolls itself because the app's `body` is `overflow: hidden` (the dashboard owns its own
 * scroll containers). A plain full-height wrapper would clip the card on a short phone screen
 * as soon as the snooze durations expand.
 */
export function RecipientShell({
  page,
  translator,
  loading = false,
  children,
}: {
  page: RecipientPage;
  /** Needed for the provider attribution; absent while the contact (and so its language) loads. */
  translator?: Translator;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 overflow-y-auto bg-neutral-50"
      style={{
        backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      <main className="flex min-h-full items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-md flex-col gap-4">
          <Card aria-busy={loading || undefined}>{children}</Card>
          {translator ? <ProviderAttribution translator={translator} page={page} /> : null}
        </div>
      </main>
    </div>
  );
}

/**
 * "Sent with Plunk": credits Plunk as the mail provider, below and outside the card, in the
 * smallest type on the page. It must never compete with the sender named in the copy, or
 * recipients read the page as Plunk's own unsubscribe.
 *
 * The sentence is translated with a `{provider}` placeholder so each language keeps its own word
 * order (Japanese puts the name first). The link carries `ref` for attribution and `noreferrer`,
 * because the page URL holds the contact id, which is the only credential these pages require.
 */
function ProviderAttribution({translator, page}: {translator: Translator; page: RecipientPage}) {
  const href = new URL(LANDING_URI);
  href.searchParams.set('ref', page);

  const template = translator.t('pages.common.sentWith');
  const [before = '', after = ''] = template.includes('{provider}') ? template.split('{provider}') : [`${template} `];

  return (
    <p className="text-center text-xs text-neutral-500">
      {before}
      <a
        href={href.toString()}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-sm align-bottom font-medium text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        <Image src="/assets/logo.svg" alt="" aria-hidden width={12} height={12} className="opacity-80" />
        Plunk
      </a>
      {after}
    </p>
  );
}

/** Title + supporting sentence at the top of a card. */
export function CardIntro({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl font-bold tracking-tight text-balance text-neutral-900">{title}</h1>
      <p className="text-sm leading-relaxed text-pretty text-neutral-600">{children}</p>
    </div>
  );
}

/**
 * Render a translated sentence with its placeholders emphasised.
 *
 * The sentences come from 16 locales with the placeholder in a different position in each, so
 * the template is split on `{name}` rather than assuming word order. The email address is the
 * part a recipient checks ("is this my work address or my personal one?"), and it used to be
 * broken mid-word by the surrounding text wrapping. As an inline-block it moves to the next line
 * whole, and only breaks inside itself when it is longer than the line.
 */
export function RichText({template, values}: {template: string; values: Record<string, string>}) {
  const parts = template.split(/(\{\w+\})/g);

  return (
    <>
      {parts.map((part, index) => {
        const match = /^\{(\w+)\}$/.exec(part);
        const key = match?.[1];

        if (key && key in values) {
          return (
            <span key={index} className="inline-block max-w-full font-medium [overflow-wrap:anywhere] text-neutral-900">
              {values[key]}
            </span>
          );
        }

        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

/** The one inline error treatment. Icon + text, so the error is never conveyed by colour alone. */
export function InlineError({message}: {message: string | null}) {
  if (!message) {
    return null;
  }

  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

/** The quiet strip along the bottom of a card, for the page's tertiary action. */
export function CardFooterNote({children}: {children: React.ReactNode}) {
  return (
    <div className="border-t border-neutral-200 bg-neutral-50/80 px-6 py-4 text-sm sm:px-8 text-neutral-600">{children}</div>
  );
}

/** Text-styled action for use inside `CardFooterNote`. */
export function FooterAction({onClick, children}: {onClick: () => void; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm font-medium text-neutral-900 underline decoration-neutral-300 underline-offset-4 transition-colors hover:decoration-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
    >
      {children}
    </button>
  );
}

/** Card skeleton while the contact loads. Same geometry as the question state, so nothing jumps. */
export function LoadingCard() {
  return (
    <div className="flex flex-col gap-6 p-6 sm:p-8" aria-hidden="true">
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

/**
 * The confirmation shown once an action has taken effect.
 *
 * One treatment for every outcome -- subscribed, unsubscribed, snoozed -- varying only the icon,
 * so a recipient learns it once. The tile settles into place rather than popping from nothing:
 * it is visible from the first frame, and the old spring-from-zero left it blank wherever the
 * animation did not run.
 */
export function ResultState({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{className?: string}>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8" role="status">
      <div className="animate-settle flex h-10 w-10 items-center justify-center rounded-full bg-green-50 text-green-700 ring-1 ring-green-600/20 ring-inset">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <CardIntro title={title}>{children}</CardIntro>
    </div>
  );
}

/** Error card for a link that could not be resolved. */
export function ErrorCard({translator, message}: {translator: Translator; message: string}) {
  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-700 ring-1 ring-red-600/20 ring-inset">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{translator.t('pages.common.error')}</h1>
        <p role="alert" className="text-sm leading-relaxed text-neutral-600">
          {message}
        </p>
      </div>
    </div>
  );
}

/**
 * The snooze choice: a quiet trigger that opens the four durations in place.
 *
 * Kept one step removed from the primary action on purpose. Four duration buttons shown up
 * front would sit level with Unsubscribe and turn a page with one job into a decision; behind a
 * ghost trigger, a recipient who came to leave never has to look past it, and one who only
 * wants a break finds it right below.
 *
 * Focus follows the disclosure: opening moves it to the first duration, cancelling returns it
 * to the trigger, so keyboard users are never stranded on an element that just disappeared.
 */
export function SnoozePicker({
  translator,
  onSnooze,
  disabled = false,
  align = 'stretch',
}: {
  translator: Translator;
  onSnooze: (duration: SnoozeDuration) => Promise<void>;
  disabled?: boolean;
  /** `stretch` fills the column under a primary button; `start` sits in a settings row. */
  align?: 'stretch' | 'start';
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<SnoozeDuration | null>(null);
  const promptId = useId();
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (open) {
      firstOptionRef.current?.focus();
    } else if (restoreFocus.current) {
      triggerRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [open]);

  const choose = async (duration: SnoozeDuration) => {
    setPending(duration);
    try {
      await onSnooze(duration);
    } finally {
      setPending(null);
    }
  };

  if (!open) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        className={align === 'stretch' ? 'w-full text-neutral-700' : '-ml-3 text-neutral-700'}
        disabled={disabled}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        <Clock aria-hidden="true" />
        {translator.t('pages.snooze.cta')}
      </Button>
    );
  }

  return (
    <div role="group"
      aria-labelledby={promptId}
      // Under a primary button the open choice needs air to read as its own step; in a settings
      // row the row padding already provides it.
      className={`animate-settle flex flex-col gap-3 ${align === 'stretch' ? 'pt-3' : ''}`}>
      <div className="flex items-baseline justify-between gap-4">
        <p id={promptId} className="text-sm font-medium text-neutral-900">
          {translator.t('pages.snooze.prompt')}
        </p>
        <button
          type="button"
          onClick={() => {
            restoreFocus.current = true;
            setOpen(false);
          }}
          disabled={pending !== null}
          className="shrink-0 rounded-sm text-sm text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {translator.t('pages.snooze.cancel')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {SNOOZE_OPTIONS.map((duration, index) => (
          <Button
            key={duration}
            ref={index === 0 ? firstOptionRef : undefined}
            type="button"
            variant="outline"
            disabled={pending !== null || disabled}
            aria-busy={pending === duration || undefined}
            onClick={() => void choose(duration)}
          >
            {pending === duration ? <IconSpinner size="sm" /> : null}
            {snoozeDurationLabel(translator, duration)}
          </Button>
        ))}
      </div>
    </div>
  );
}
