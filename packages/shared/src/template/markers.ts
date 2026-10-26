import {brandToMarkerText, type EmailBrand, markerTextToBrand} from './brand.js';
import {escapeHtml} from './html.js';
import {decodeEntities} from './preprocess.js';

/**
 * What an email carries besides its content lives in comments at the very start of its body, so
 * it needs no column of its own and survives anywhere the body is copied: first its preview text
 * (preheader), then its brand.
 *
 * The preheader is kept HTML-escaped: a `>` cannot close the comment early, and the API can place
 * it in the email as it is. Liquid still renders inside it, so `{{ variables }}` work in the
 * preview text too. The brand only holds `key=value` pairs of letters, digits, `#` and `-`, so
 * nothing in it reads as Liquid or can close the comment.
 */
const PREHEADER_PATTERN = /^<!--plunk:preheader:([\s\S]*?)-->/;
const BRAND_PATTERN = /^<!--plunk:brand:([a-z0-9#=;-]*)-->/;

export interface EmailMarkers {
  /** Still HTML-escaped; empty for none. */
  preheader: string;
  /** null for an email written before brands, which keeps the look emails always had. */
  brand: EmailBrand | null;
  body: string;
}

/** Separates an email's preheader and brand from its content. */
export function splitEmailMarkers(value: string): EmailMarkers {
  let body = value;

  const preheader = PREHEADER_PATTERN.exec(body);
  if (preheader) body = body.slice(preheader[0].length);

  const brand = BRAND_PATTERN.exec(body);
  if (brand) body = body.slice(brand[0].length);

  return {
    preheader: preheader?.[1] ?? '',
    brand: brand ? markerTextToBrand(brand[1] ?? '') : null,
    body,
  };
}

/** An email's body with its preheader and brand in front, in that order. */
export function joinEmailMarkers({preheader, brand, body}: EmailMarkers): string {
  return [
    preheader ? `<!--plunk:preheader:${preheader}-->` : '',
    brand ? `<!--plunk:brand:${brandToMarkerText(brand)}-->` : '',
    body,
  ].join('');
}

/** The stored preheader as the plain text an author typed. */
export function preheaderToText(preheader: string): string {
  return decodeEntities(preheader);
}

/** Plain text typed by an author as a stored preheader. Blank text means no preheader. */
export function textToPreheader(text: string): string {
  return text.trim() ? escapeHtml(text) : '';
}
