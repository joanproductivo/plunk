import {escapeHtml} from './html.js';
import {decodeEntities} from './preprocess.js';

/**
 * An email's preview text (preheader) lives in a comment at the very start of its body, so it
 * needs no column of its own and survives anywhere the body is copied. Its text is kept
 * HTML-escaped: a `>` cannot close the comment early, and the API can place it in the email as
 * it is. Liquid still renders inside it, so `{{ variables }}` work in the preview text too.
 */
const PREHEADER_PATTERN = /^<!--plunk:preheader:([\s\S]*?)-->/;

/** Separates the preheader (still HTML-escaped) from the rest of the body. */
export function splitPreheader(body: string): {preheader: string; body: string} {
  const match = PREHEADER_PATTERN.exec(body);
  if (!match) {
    return {preheader: '', body};
  }

  return {preheader: match[1] ?? '', body: body.slice(match[0].length)};
}

/** Puts `preheader` (HTML-escaped) at the start of `body`, replacing any it already has. */
export function withPreheader(preheader: string, body: string): string {
  const {body: content} = splitPreheader(body);
  return preheader ? `<!--plunk:preheader:${preheader}-->${content}` : content;
}

/** The stored preheader as the plain text an author typed. */
export function preheaderToText(preheader: string): string {
  return decodeEntities(preheader);
}

/** Plain text typed by an author as a stored preheader. Blank text means no preheader. */
export function textToPreheader(text: string): string {
  return text.trim() ? escapeHtml(text) : '';
}
