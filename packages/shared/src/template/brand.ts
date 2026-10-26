/**
 * An email's brand: the font, colours, background and width it is written and sent in. Each email
 * keeps the brand it was given in a comment at the start of its body (see markers.ts), so sending
 * reads nothing else and changing the project's brand never changes an email already written.
 */

import {type ButtonStyle, normalizeHexColor, toButtonStyle} from './emailButton.js';
import {EMAIL_FONTS, type EmailFont} from './emailFonts.js';

export interface EmailBrand {
  /** null keeps the email's own font (EMAIL_FONT_FAMILY). */
  font: EmailFont | null;
  /** Body text, lists and quotes' surroundings. */
  textColor: string;
  /** Headings and bold text. */
  headingColor: string;
  linkColor: string;
  /** Around the content; null for none. */
  backgroundColor: string | null;
  /** The content's own background, behind the text when there is a background or a width. */
  contentColor: string;
  /** The content's width in px, centred; null for the full width. */
  contentWidth: number | null;
}

/** The project's brand: what new emails are written in, and what new buttons look like. */
export interface ProjectBrand extends EmailBrand {
  button: ButtonStyle;
}

/** The look of emails before brands: an email without one is sent exactly as it always was. */
export const BRAND_DEFAULTS: EmailBrand = {
  font: null,
  textColor: '#374151',
  headingColor: '#111827',
  linkColor: '#3b82f6',
  backgroundColor: null,
  contentColor: '#ffffff',
  contentWidth: null,
};

export const BRAND_MIN_WIDTH = 480;
export const BRAND_MAX_WIDTH = 800;

function toWidth(value: unknown): number | null {
  const width = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof width === 'number' && Number.isInteger(width) && width >= BRAND_MIN_WIDTH && width <= BRAND_MAX_WIDTH
    ? width
    : null;
}

/**
 * A brand from untrusted data (a request, a stored row, a marker in a body), keeping only known
 * values and falling back to the defaults for the rest. Everything it returns is safe to write
 * into CSS: colours are `#rrggbb`, the font is one of EMAIL_FONTS and the width an integer.
 */
export function toEmailBrand(value: unknown): EmailBrand {
  const data = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const color = (key: string, fallback: string) => normalizeHexColor(String(data[key] ?? '')) ?? fallback;

  return {
    font: typeof data.font === 'string' && Object.hasOwn(EMAIL_FONTS, data.font) ? (data.font as EmailFont) : null,
    textColor: color('textColor', BRAND_DEFAULTS.textColor),
    headingColor: color('headingColor', BRAND_DEFAULTS.headingColor),
    linkColor: color('linkColor', BRAND_DEFAULTS.linkColor),
    backgroundColor: normalizeHexColor(String(data.backgroundColor ?? '')),
    contentColor: color('contentColor', BRAND_DEFAULTS.contentColor),
    contentWidth: toWidth(data.contentWidth),
  };
}

export function toProjectBrand(value: unknown): ProjectBrand {
  const data = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {...toEmailBrand(data), button: toButtonStyle(data.button)};
}

/** Whether two brands give an email the same look. */
export function sameEmailBrand(a: EmailBrand, b: EmailBrand): boolean {
  return (Object.keys(BRAND_DEFAULTS) as (keyof EmailBrand)[]).every(key => a[key] === b[key]);
}

// The marker's keys, short so that every email carries few bytes
const MARKER_KEYS = {
  font: 'font',
  textColor: 'text',
  headingColor: 'heading',
  linkColor: 'link',
  backgroundColor: 'background',
  contentColor: 'content',
  contentWidth: 'width',
} as const satisfies Record<keyof EmailBrand, string>;

/** A brand as the text of its marker: `key=value` pairs, leaving out what is null. */
export function brandToMarkerText(brand: EmailBrand): string {
  return (Object.keys(MARKER_KEYS) as (keyof EmailBrand)[])
    .filter(key => brand[key] !== null)
    .map(key => `${MARKER_KEYS[key]}=${brand[key]}`)
    .join(';');
}

/** The brand a marker's text describes; anything unknown or invalid takes the default. */
export function markerTextToBrand(text: string): EmailBrand {
  const values = new Map(
    text.split(';').map(pair => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    }),
  );
  const data: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(MARKER_KEYS)) {
    if (values.has(name)) data[key] = values.get(name);
  }
  return toEmailBrand(data);
}
