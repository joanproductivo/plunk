import {
  BRAND_DEFAULTS,
  type EmailBrand,
  emailFontFamily,
  type ProjectBrand,
  sameEmailBrand,
  toEmailBrand,
} from '@plunk/shared';
import type {CSSProperties} from 'react';
import useSWR from 'swr';

/** The URL a project's brand is read from and saved to. */
export const brandUrl = (projectId: string) => `/projects/${projectId}/brand`;

/** Whether an email has no content yet: nothing, or the empty paragraph the editor leaves. */
export function isEmptyBody(body: string): boolean {
  return /^(<p><\/p>)?$/.test(body.trim());
}

/**
 * The brand an email is saved with on a change: its own if it has one. An email that had no
 * content until this change takes the project's, so a new email is written in the brand; one
 * written before brands keeps the look it had until "Apply brand". Nothing is written on load,
 * whatever order the body and the project's brand arrive in: only a change asks.
 */
export function brandOnChange(brand: EmailBrand | null, bodyBefore: string, project: EmailBrand | null) {
  return brand ?? (isEmptyBody(bodyBefore) ? project : null);
}

/**
 * The editor's attributes in `look`. Tailwind Typography declares its colours as variables on
 * the .prose element itself, so they are set inline on that element, which no class outranks.
 */
export function editorAttributes(look: EmailBrand): Record<string, string> {
  return {
    class: 'prose prose-sm max-w-none focus:outline-none min-h-[400px] px-4 py-3',
    style: [
      `--tw-prose-body: ${look.textColor}`,
      `--tw-prose-headings: ${look.headingColor}`,
      `--tw-prose-bold: ${look.headingColor}`,
      `--tw-prose-links: ${look.linkColor}`,
      `font-family: ${emailFontFamily(look)}`,
    ].join('; '),
  };
}

/** The page around the editor in `look`: its background, and its column when it has a width. */
export function canvasStyle(look: EmailBrand): {outer: CSSProperties; inner: CSSProperties} {
  const framed = look.backgroundColor !== null || look.contentWidth !== null;
  return {
    outer: {backgroundColor: look.backgroundColor ?? undefined, padding: framed ? 16 : undefined},
    inner: framed
      ? {maxWidth: look.contentWidth ?? undefined, margin: '0 auto', backgroundColor: look.contentColor}
      : {},
  };
}

/**
 * An email's brand in the editor: the look it is shown in, the project's brand, and whether the
 * two differ, which offers "Apply brand". An email without a brand is shown as it is sent, in the
 * defaults, unless it is still empty, when it will take the project's.
 */
export function useEmailBrand(projectId: string | undefined, brand: EmailBrand | null, body: string) {
  const {data} = useSWR<ProjectBrand>(projectId ? brandUrl(projectId) : null, {revalidateOnFocus: false});
  const project = data ? toEmailBrand(data) : null;
  const empty = isEmptyBody(body);

  return {
    look: brand ?? (empty && project ? project : BRAND_DEFAULTS),
    project,
    button: data?.button,
    differs: project !== null && !empty && !sameEmailBrand(brand ?? BRAND_DEFAULTS, project),
  };
}
