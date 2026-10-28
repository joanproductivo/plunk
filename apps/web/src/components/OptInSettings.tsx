import {
  BRAND_DEFAULTS,
  isPlunkOptInText,
  type OptInSchemas,
  optInEmail,
  plunkOptInText,
  type ProjectBrand,
  resolveContactLanguage,
  SUPPORTED_LANGUAGES,
  toOptInTexts,
} from '@plunk/shared';
import type {OptInSettingsData, OptInText, OptInTexts} from '@plunk/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
  Textarea,
} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../lib/network';

import {OptionSelect} from './EmailEditor/BlockFields';
import {brandUrl} from './EmailEditor/useEmailBrand';

/** The URL a project's double opt-in is read from and saved to. */
const optInUrl = (projectId: string) => `/projects/${projectId}/optin`;

// The texts as JSON whatever order their languages were added in, to tell whether they changed
const canonical = (settings: OptInSettingsData) =>
  JSON.stringify({...settings, texts: Object.entries(settings.texts).sort(([a], [b]) => a.localeCompare(b))});

interface OptInSettingsProps {
  projectId: string;
  projectName: string;
  language: string;
  canEdit: boolean;
}

export function OptInSettings(props: OptInSettingsProps) {
  const {data, error} = useSWR<OptInSettingsData>(optInUrl(props.projectId), {revalidateOnFocus: false});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Double opt-in</CardTitle>
        <CardDescription>
          Sign-ups wait until the contact clicks the link in a confirmation email: an event, a contact created with an
          API key, a transactional send with <code>subscribed: true</code>, the public subscribe page and a
          workflow&apos;s subscribe step. Until then they show as “Pending confirmation”, receive no campaigns or
          marketing emails, and start no <code>contact.subscribed</code> workflows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data ? (
          // Mounted once the settings load, so the form starts from them, and again for another project
          <OptInForm key={props.projectId} {...props} saved={data} />
        ) : error ? (
          <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}

function OptInForm({
  projectId,
  projectName,
  language,
  canEdit,
  saved,
}: OptInSettingsProps & {saved: OptInSettingsData}) {
  const [settings, setSettings] = useState<OptInSettingsData>(saved);
  const [code, setCode] = useState(resolveContactLanguage(null, language));
  const [saving, setSaving] = useState(false);
  const {mutate} = useSWR<OptInSettingsData>(optInUrl(projectId), {revalidateOnFocus: false});
  const {data: brand} = useSWR<ProjectBrand>(brandUrl(projectId), {revalidateOnFocus: false});

  const own = Object.hasOwn(settings.texts, code) ? settings.texts[code] : undefined;
  const shown = own ?? plunkOptInText(code);
  const {errors} = toOptInTexts(settings.texts);
  const changed = canonical(settings) !== canonical(saved);
  const missingSender = settings.enabled && !settings.fromEmail?.trim();

  const restore = () =>
    setSettings(prev => ({
      ...prev,
      texts: Object.fromEntries(Object.entries(prev.texts).filter(([key]) => key !== code)) as OptInTexts,
    }));
  // Edited back to just what Plunk's says, a language needs no text of its own
  const edit = (field: keyof OptInText, value: string) => {
    const next = {...shown, [field]: value};
    if (isPlunkOptInText(next, code)) restore();
    else setSettings(prev => ({...prev, texts: {...prev.texts, [code]: next}}));
  };

  const languages = Object.fromEntries(
    SUPPORTED_LANGUAGES.map(({code: key, nativeName}) => [
      key,
      Object.hasOwn(settings.texts, key) ? `${nativeName} · own text` : nativeName,
    ]),
  );

  const save = async () => {
    setSaving(true);
    try {
      const next = await network.fetch<OptInSettingsData, typeof OptInSchemas.update>('PUT', optInUrl(projectId), {
        ...settings,
        fromEmail: settings.fromEmail?.trim() || null,
        fromName: settings.fromName?.trim() || null,
      });
      setSettings(next);
      await mutate(next, {revalidate: false});
      toast.success(next.enabled ? 'Double opt-in on' : 'Double opt-in saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the double opt-in. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const preview = optInEmail({
    language: code,
    projectName,
    url: '#',
    texts: settings.texts,
    brand: brand ?? BRAND_DEFAULTS,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="optin-enabled" className="font-medium cursor-pointer">
              Ask sign-ups to confirm
            </Label>
            <p className="text-xs text-neutral-500 mt-0.5">
              With the public key (<code>pk_</code>), <code>/v1/track</code> sends no confirmation and leaves the
              contact unsubscribed: sign up from your server with the secret key. Contacts you add or subscribe yourself
              are subscribed at once; an import subscribes new contacts only, and adding to a segment subscribes no one.
            </p>
          </div>
          <Switch
            id="optin-enabled"
            checked={settings.enabled}
            disabled={!canEdit}
            onCheckedChange={enabled => setSettings(prev => ({...prev, enabled}))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="optin-from" className="text-sm font-medium mb-2 block">
              From address
            </Label>
            <Input
              id="optin-from"
              type="email"
              placeholder="hello@yourdomain.com"
              value={settings.fromEmail ?? ''}
              disabled={!canEdit}
              onChange={e => setSettings(prev => ({...prev, fromEmail: e.target.value}))}
            />
            <p className="mt-1 text-xs text-neutral-500">On one of the project&apos;s verified domains.</p>
          </div>
          <div>
            <Label htmlFor="optin-from-name" className="text-sm font-medium mb-2 block">
              From name
            </Label>
            <Input
              id="optin-from-name"
              placeholder={projectName}
              value={settings.fromName ?? ''}
              disabled={!canEdit}
              onChange={e => setSettings(prev => ({...prev, fromName: e.target.value}))}
            />
          </div>
        </div>

        <OptionSelect label="Language" value={code} options={languages} onChange={setCode} />
        <div>
          <Label htmlFor="optin-subject" className="text-sm font-medium mb-2 block">
            Subject
          </Label>
          <Input
            id="optin-subject"
            value={shown.subject}
            disabled={!canEdit}
            onChange={e => edit('subject', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="optin-text" className="text-sm font-medium mb-2 block">
            Text
          </Label>
          <Textarea
            id="optin-text"
            rows={5}
            value={shown.text}
            disabled={!canEdit}
            onChange={e => edit('text', e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            {'{projectName}'} becomes the project&apos;s name; a blank line starts a new paragraph. The button with the
            link goes after the text.
          </p>
        </div>
        <div>
          <Label htmlFor="optin-button" className="text-sm font-medium mb-2 block">
            Button text
          </Label>
          <Input
            id="optin-button"
            value={shown.buttonText}
            disabled={!canEdit}
            onChange={e => edit('buttonText', e.target.value)}
          />
        </div>
        {errors.length > 0 && <p className="text-xs text-red-700">{errors.join(' ')}</p>}
        {missingSender && <p className="text-xs text-red-700">Choose the address the confirmation emails come from.</p>}
        {settings.enabled && !saved.enabled && (
          <p className="text-xs text-amber-800">
            Before turning it on, check the workflows that start with your sign-up event: their marketing emails are
            skipped until the contact confirms. Start welcome emails on <code>contact.subscribed</code> instead.
          </p>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-4">
          {canEdit ? (
            <>
              <Button type="button" variant="outline" onClick={restore} disabled={!own}>
                Restore Plunk&apos;s text
              </Button>
              <Button type="button" onClick={save} disabled={!changed || errors.length > 0 || missingSender || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <p className="text-sm text-neutral-500">Only admins can change the double opt-in.</p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-900">Preview</p>
        <p className="mb-2 text-sm text-neutral-700">
          <span className="text-neutral-500">Subject:</span> {preview.subject}
        </p>
        <iframe
          title="Confirmation email preview"
          sandbox=""
          srcDoc={preview.body}
          className="h-[360px] w-full rounded border border-neutral-200 bg-white"
        />
      </div>
    </div>
  );
}
