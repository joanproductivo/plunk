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
  /** Body text and lists; quotes, code and tables keep their own colour. */
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

const MIN_WIDTH = 480;
const MAX_WIDTH = 800;

function toWidth(value: unknown): number | null {
  const width = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof width === 'number' && Number.isInteger(width) && width >= MIN_WIDTH && width <= MAX_WIDTH
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
  // Only strings: String() of an object that cannot convert would throw
  const hex = (key: string) => normalizeHexColor(typeof data[key] === 'string' ? data[key] : '');
  const color = (key: string, fallback: string) => hex(key) ?? fallback;

  return {
    font: typeof data.font === 'string' && Object.hasOwn(EMAIL_FONTS, data.font) ? (data.font as EmailFont) : null,
    textColor: color('textColor', BRAND_DEFAULTS.textColor),
    headingColor: color('headingColor', BRAND_DEFAULTS.headingColor),
    linkColor: color('linkColor', BRAND_DEFAULTS.linkColor),
    backgroundColor: hex('backgroundColor'),
    contentColor: color('contentColor', BRAND_DEFAULTS.contentColor),
    contentWidth: toWidth(data.contentWidth),
  };
}

export function toProjectBrand(value: unknown): ProjectBrand {
  const data = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {...toEmailBrand(data), button: toButtonStyle(data.button)};
}

/** Whether an email in `brand` is framed: drawn on a background, or in a column of its own width. */
export function isFramedBrand(brand: EmailBrand): boolean {
  return brand.backgroundColor !== null || brand.contentWidth !== null;
}

/** Whether two brands give an email the same look. */
export function sameEmailBrand(a: EmailBrand, b: EmailBrand): boolean {
  return (Object.keys(BRAND_DEFAULTS) as (keyof EmailBrand)[]).every(key => a[key] === b[key]);
}
