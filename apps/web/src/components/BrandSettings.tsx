import {
  type BrandSchemas,
  buttonStyle,
  EMAIL_FOOTER_SLOT,
  isFramedBrand,
  normalizeHexColor,
  type ProjectBrand,
  toProjectBrand,
} from '@plunk/shared';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Label} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {wrapEmailWithStyles} from '../lib/emailStyles';
import {network} from '../lib/network';
import {ColorField, FontSelect, OptionSelect} from './EmailEditor/BlockFields';
import {ButtonStyleFields} from './EmailEditor/ButtonDialog';
import {brandUrl} from './EmailEditor/useEmailBrand';

const FULL_WIDTH = 'full';
const WIDTHS = {[FULL_WIDTH]: 'Full width', '560': '560 px', '600': '600 px', '640': '640 px'};

// What the preview shows: each style the brand sets, once
// Like the unsubscribe footer the API adds (EmailService.compile), so its legibility shows
const SAMPLE_FOOTER =
  '<hr style="border: none; border-top: 1px solid #eaeaea; margin: 12px 0;">' +
  '<p style="font-size: 12px; line-height: 24px; margin: 16px 0; text-align: center; color: rgb(64, 64, 64);">' +
  'You received this email from Your project. <a href="#">Update your preferences</a>.</p>';

const sample = (brand: ProjectBrand) =>
  '<h1>Your weekly update</h1><p>Hi Ana, here is <strong>what changed</strong> this week and ' +
  '<a href="#">what comes next</a>.</p><h2>Highlights</h2><ul><li><p>A new look for every email</p></li></ul>' +
  `<p style="text-align: center;"><a class="email-button" href="#" style="${buttonStyle(brand.button)}">Read more</a></p>`;

export function BrandSettings({projectId, canEdit}: {projectId: string; canEdit: boolean}) {
  const {data, error} = useSWR<ProjectBrand>(brandUrl(projectId), {revalidateOnFocus: false});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brand</CardTitle>
        <CardDescription>
          The font, colors and layout new emails are written in. Each email keeps the brand it was written in: open one
          and choose Apply brand to bring it up to date.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>
        ) : !data ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          // Mounted once the brand loads, so the form starts from it
          <BrandForm projectId={projectId} canEdit={canEdit} initial={data} />
        )}
      </CardContent>
    </Card>
  );
}

function BrandForm({projectId, canEdit, initial}: {projectId: string; canEdit: boolean; initial: ProjectBrand}) {
  const [brand, setBrand] = useState(initial);
  const [saving, setSaving] = useState(false);
  const {mutate} = useSWR<ProjectBrand>(brandUrl(projectId));

  const set = <K extends keyof ProjectBrand>(key: K, value: ProjectBrand[K]) =>
    setBrand(prev => ({...prev, [key]: value}));
  const colors = [
    brand.textColor,
    brand.headingColor,
    brand.linkColor,
    brand.contentColor,
    brand.button.backgroundColor,
    brand.button.textColor,
  ];
  const valid =
    colors.every(color => normalizeHexColor(color) !== null) &&
    (brand.backgroundColor === null || normalizeHexColor(brand.backgroundColor) !== null);
  // A width set outside these options (through the API) stays selectable
  const widths = brand.contentWidth ? {...WIDTHS, [String(brand.contentWidth)]: `${brand.contentWidth} px`} : WIDTHS;
  const framed = isFramedBrand(brand);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await network.fetch<ProjectBrand, typeof BrandSchemas.update>('PUT', brandUrl(projectId), brand);
      setBrand(saved);
      await mutate(saved, {revalidate: false});
      toast.success('Brand saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the brand. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <FontSelect label="Font" value={brand.font} ownFont="System font" onChange={value => set('font', value)} />
        <div className="grid grid-cols-3 gap-3">
          <ColorField
            id="brand-text"
            label="Text"
            value={brand.textColor}
            onChange={value => set('textColor', value)}
          />
          <ColorField
            id="brand-heading"
            label="Headings"
            value={brand.headingColor}
            onChange={value => set('headingColor', value)}
          />
          <ColorField
            id="brand-link"
            label="Links"
            value={brand.linkColor}
            onChange={value => set('linkColor', value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="brand-has-background"
            checked={brand.backgroundColor !== null}
            onCheckedChange={checked => set('backgroundColor', checked === true ? '#f3f4f6' : null)}
          />
          <Label htmlFor="brand-has-background" className="text-sm">
            Background around the email
          </Label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {brand.backgroundColor !== null && (
            <ColorField
              id="brand-background"
              label="Background"
              value={brand.backgroundColor}
              onChange={value => set('backgroundColor', value)}
            />
          )}
          {framed && (
            <ColorField
              id="brand-content"
              label="Content"
              value={brand.contentColor}
              onChange={value => set('contentColor', value)}
            />
          )}
        </div>
        <OptionSelect
          label="Width"
          value={brand.contentWidth ? String(brand.contentWidth) : FULL_WIDTH}
          options={widths}
          onChange={value => set('contentWidth', value === FULL_WIDTH ? null : Number(value))}
        />

        <div className="space-y-4 border-t border-neutral-200 pt-4">
          <p className="text-sm font-medium text-neutral-900">New buttons</p>
          <ButtonStyleFields idPrefix="brand-button" value={brand.button} onChange={value => set('button', value)} />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-4">
          {canEdit ? (
            <>
              <Button type="button" variant="outline" onClick={() => setBrand(toProjectBrand({}))}>
                Reset
              </Button>
              <Button type="button" onClick={save} disabled={!valid || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <p className="text-sm text-neutral-500">Only admins can change the brand.</p>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-900">Preview</p>
        <iframe
          title="Brand preview"
          sandbox=""
          srcDoc={wrapEmailWithStyles(sample(brand), toProjectBrand(brand)).replace(EMAIL_FOOTER_SLOT, SAMPLE_FOOTER)}
          className="h-[480px] w-full rounded border border-neutral-200 bg-white"
        />
      </div>
    </div>
  );
}
