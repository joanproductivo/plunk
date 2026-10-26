import {
  BRAND_DEFAULTS,
  createTranslatorSync,
  footerParagraph,
  type FooterSchemas,
  type ProjectBrand,
  type ProjectFooter,
  type ProjectFooters,
  resolveFooterLanguage,
  SUPPORTED_LANGUAGES,
  toProjectFooters,
} from '@plunk/shared';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {wrapEmailWithFooter} from '../lib/emailStyles';
import {network} from '../lib/network';
import {OptionSelect} from './EmailEditor/BlockFields';
import {brandUrl} from './EmailEditor/useEmailBrand';

/** The URL a project's own footers are read from and saved to. */
export const footersUrl = (projectId: string) => `/projects/${projectId}/footers`;

// What the preview shows above the footer
const SAMPLE = '<p>Hi Ana, this is the end of an email.</p>';

/** Plunk's own footer in `code`, as a starting point: {projectName} is left for the author. */
function plunkFooter(code: string): ProjectFooter {
  const translator = createTranslatorSync(code);
  return {
    text: translator.t('email.footer.unsubscribeText'),
    linkText: translator.t('email.footer.updatePreferences'),
  };
}

interface FooterSettingsProps {
  projectId: string;
  projectName: string;
  language: string;
  canEdit: boolean;
}

export function FooterSettings(props: FooterSettingsProps) {
  const {data, error} = useSWR<ProjectFooters>(footersUrl(props.projectId), {revalidateOnFocus: false});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unsubscribe footer</CardTitle>
        <CardDescription>
          The text at the end of every marketing email, in each contact&apos;s language. Languages without a text of
          their own use Plunk&apos;s.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>
        ) : !data ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          // Mounted once the footers load, so the form starts from them
          <FooterForm {...props} saved={data} />
        )}
      </CardContent>
    </Card>
  );
}

function FooterForm({projectId, projectName, language, canEdit, saved}: FooterSettingsProps & {saved: ProjectFooters}) {
  // Only languages with a footer of their own are here: the others show Plunk's and stay Plunk's
  const [footers, setFooters] = useState<ProjectFooters>(saved);
  const [code, setCode] = useState(resolveFooterLanguage(null, language));
  const [saving, setSaving] = useState(false);
  const {mutate} = useSWR<ProjectFooters>(footersUrl(projectId));
  const {data: brand} = useSWR<ProjectBrand>(brandUrl(projectId), {revalidateOnFocus: false});

  const own = Object.hasOwn(footers, code) ? footers[code] : undefined;
  const shown = own ?? plunkFooter(code);
  const {errors} = toProjectFooters(footers);
  const changed = JSON.stringify(footers) !== JSON.stringify(saved);

  const edit = (field: keyof ProjectFooter, value: string) =>
    setFooters(prev => ({...prev, [code]: {...shown, [field]: value}}));
  const restore = () =>
    setFooters(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== code)) as ProjectFooters);

  const languages = Object.fromEntries(
    SUPPORTED_LANGUAGES.map(({code: key, nativeName}) => [
      key,
      Object.hasOwn(footers, key) ? `${nativeName} · own text` : nativeName,
    ]),
  );

  const save = async () => {
    setSaving(true);
    try {
      const next = await network.fetch<ProjectFooters, typeof FooterSchemas.update>(
        'PUT',
        footersUrl(projectId),
        footers,
      );
      setFooters(next);
      await mutate(next, {revalidate: false});
      toast.success('Footer saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the footer. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <OptionSelect label="Language" value={code} options={languages} onChange={setCode} />
        <div>
          <Label htmlFor="footer-text" className="text-sm font-medium mb-2 block">
            Text
          </Label>
          <Textarea id="footer-text" rows={5} value={shown.text} onChange={e => edit('text', e.target.value)} />
          <p className="mt-1 text-xs text-neutral-500">
            {'{projectName}'} becomes the project&apos;s name, and {'{link}'} the link to update preferences. Without{' '}
            {'{link}'}, the link goes at the end: it is always added.
          </p>
        </div>
        <div>
          <Label htmlFor="footer-link" className="text-sm font-medium mb-2 block">
            Link text
          </Label>
          <Input id="footer-link" value={shown.linkText} onChange={e => edit('linkText', e.target.value)} />
        </div>
        {errors.length > 0 && <p className="text-xs text-red-700">{errors.join(' ')}</p>}

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-4">
          {canEdit ? (
            <>
              <Button type="button" variant="outline" onClick={restore} disabled={!own}>
                Restore Plunk&apos;s text
              </Button>
              <Button type="button" onClick={save} disabled={!changed || errors.length > 0 || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <p className="text-sm text-neutral-500">Only admins can change the footer.</p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-900">Preview</p>
        <iframe
          title="Footer preview"
          sandbox=""
          srcDoc={wrapEmailWithFooter(
            SAMPLE,
            brand ?? BRAND_DEFAULTS,
            footerParagraph({language: code, projectName, href: '#', footers}),
          )}
          className="h-[320px] w-full rounded border border-neutral-200 bg-white"
        />
      </div>
    </div>
  );
}
