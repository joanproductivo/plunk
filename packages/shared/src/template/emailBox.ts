/**
 * The email editor's box: a block of other blocks on a background colour, inset with rounded
 * corners or across the whole column. Saved as <div class="email-box" style="…">, its colours in
 * the inline style and its width in the class; the dashboard writes and reads it, and the API
 * reads it again when sending, to send it as a table every client keeps.
 */

import {contrastRatio} from './color.js';
import {normalizeHexColor} from './emailButton.js';
import {declarations} from './inlineStyle.js';

export interface BoxStyle {
  backgroundColor: string;
  textColor: string;
  /** Across the whole column, square, rather than inset with rounded corners. */
  fullWidth: boolean;
}

export const BOX_DEFAULTS: BoxStyle = {backgroundColor: '#f3f4f6', textColor: '#374151', fullWidth: false};

export const BOX_CLASS = 'email-box';
export const BOX_FULL_WIDTH_CLASS = 'email-box-full';

/** Rounding of an inset box, in px, as the framed column's; Outlook for Windows squares it. */
export const BOX_RADIUS = 12;

/**
 * Padding inside a box, in px: a full-width one keeps its text in line with the column's, an inset
 * one leaves more room for it on a phone.
 */
export const BOX_PADDING = {fullWidth: 24, inset: 16} as const;

export const boxPadding = (fullWidth: boolean) => (fullWidth ? BOX_PADDING.fullWidth : BOX_PADDING.inset);

/** The class a box is saved with. */
export const boxClass = (fullWidth: boolean) => (fullWidth ? `${BOX_CLASS} ${BOX_FULL_WIDTH_CLASS}` : BOX_CLASS);

/** The inline style a box is saved with, as browsers serialise it, so it reads back unchanged. */
export function boxStyle(style: Pick<BoxStyle, 'backgroundColor' | 'textColor'>): string {
  return `background-color: ${style.backgroundColor}; color: ${style.textColor};`;
}

/** A box's colours from its inline style; anything that is not a colour falls back to the default. */
export function readBoxColors(style: string | null | undefined): Pick<BoxStyle, 'backgroundColor' | 'textColor'> {
  const values = declarations(style);
  return {
    backgroundColor: normalizeHexColor(values.get('background-color')) ?? BOX_DEFAULTS.backgroundColor,
    textColor: normalizeHexColor(values.get('color')) ?? BOX_DEFAULTS.textColor,
  };
}

/** Whether a box's class makes it full width. */
export function isFullWidthBox(className: string | null | undefined): boolean {
  return (className ?? '').split(/\s+/).includes(BOX_FULL_WIDTH_CLASS);
}

const DARK_TEXT = '#111827';
const LIGHT_TEXT = '#ffffff';

/** WCAG's contrast for text, which a box's text colour is suggested to meet. */
export const TEXT_CONTRAST = 4.5;

/**
 * The text colour suggested on `background`: the brand's, when it reads there, or else dark or
 * white, whichever reads better.
 */
export function suggestedTextColor(background: string, brandText: string): string {
  if (contrastRatio(background, brandText) >= TEXT_CONTRAST) return brandText;
  return contrastRatio(background, DARK_TEXT) >= contrastRatio(background, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}
