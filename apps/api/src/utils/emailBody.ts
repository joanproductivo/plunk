import {splitPreheader} from '@plunk/shared';
import {load} from 'cheerio/slim';
import makeJuiceClient from 'juice/lib/inline.js';
import signale from 'signale';

import {EMAIL_PROSE_CSS} from './emailProseCss.js';

// juice's main entry pulls in full cheerio (parse5, undici) and web-resource-inliner, ~28 MB of
// resident memory per process. Its inliner core on cheerio's htmlparser2 build costs ~2 MB.
const juice = makeJuiceClient({});

/**
 * Gmail clips messages above 102 KB, hiding the rest, including the unsubscribe footer. Measured
 * before the footer is added and before SES rewrites links for tracking, hence the margin.
 */
const GMAIL_CLIP_WARNING_BYTES = 80_000;

/** The same campaign renders once per recipient; one line a minute per kind of warning is enough. */
const WARNING_INTERVAL_MS = 60_000;
const lastWarnedAt = new Map<string, number>();

function warnAtMostEveryMinute(kind: string, message: string, error?: unknown): void {
  const now = Date.now();
  if (now - (lastWarnedAt.get(kind) ?? 0) < WARNING_INTERVAL_MS) {
    return;
  }

  lastWarnedAt.set(kind, now);
  if (error === undefined) {
    signale.warn(message);
  } else {
    signale.warn(message, error);
  }
}

/**
 * Hides the preheader in the body while clients show it as the inbox preview. The filler after
 * it keeps clients from padding the preview with the start of the body.
 */
const PREHEADER_STYLE =
  'display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0';
const PREHEADER_FILL = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * Detects if HTML contains custom patterns that indicate it was written in the HTML editor
 * rather than the visual editor. Mirrors the same logic in apps/web/src/lib/emailStyles.ts.
 *
 * The TipTap editor loads StarterKit + TextAlign + Color + TextStyle + Link +
 * ResizableImage + VariableMention. TextStyle/Color/Link round-trip <span style="..."> and
 * <a style="..."> markup. This detection therefore PERMITS span + inline styles and only
 * REJECTS markup TipTap cannot represent (tables, divs, forms, embeds, custom attrs,
 * <style> blocks, etc).
 */
function detectCustomHtmlPatterns(html: string): boolean {
  if (!html || html.trim() === '') return false;

  const classMatches = html.matchAll(/class\s*=\s*["']([^"']*)["']/gi);
  let hasCustomClasses = false;
  for (const match of classMatches) {
    const classValue = match[1];
    if (!classValue) continue;
    const classes = classValue.split(/\s+/).filter((c: string) => c.length > 0);
    const allowedPrefixes = [
      'prose',
      'variable-',
      'email-image',
      'ProseMirror',
      'resizable-image',
      'selected',
      'resize-handle',
    ];
    const hasDisallowedClass = classes.some(
      (cls: string) => !allowedPrefixes.some((prefix: string) => cls.startsWith(prefix)),
    );
    if (hasDisallowedClass) {
      hasCustomClasses = true;
      break;
    }
  }

  // Element-attribute-scoped regex; the leading [\s"'] guard prevents `id=` inside
  // href URLs (e.g. `?id=...`) from false-matching as an HTML id attribute.
  const hasCustomAttributes = /<[a-z][^>]*?[\s"'](?:data-|aria-|role=|id=)/i.test(html);

  // Elements TipTap cannot round-trip with the currently-loaded extension set.
  // <span> is intentionally excluded -- TipTap's TextStyle extension handles it.
  const hasCustomElements =
    /<(?:div|section|article|header|footer|nav|aside|main|table|tr|td|th|tbody|thead|tfoot|colgroup|col|form|input|button|select|textarea|iframe|video|audio|svg|object|embed|details|summary|dialog)\b/i.test(
      html,
    );

  const hasMediaQueries = /@media/i.test(html);
  const hasStyleTags = /<style[^>]*>/i.test(html);

  return hasCustomClasses || hasCustomAttributes || hasCustomElements || hasMediaQueries || hasStyleTags;
}

/** A full email document around visual editor content. `styleBlock` is only used as a fallback. */
function emailDocument(htmlBody: string, styleBlock?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${styleBlock ? `\n  <style>\n${styleBlock}\n  </style>` : ''}
</head>
<body>
  <div class="prose prose-sm max-w-none">
    ${htmlBody}
  </div>
</body>
</html>`;
}

/**
 * Wraps visual editor content in a document with the prose styles inlined.
 *
 * Inlining differs from the preview in two small ways: ::before/::after rules (the backticks
 * around inline code) cannot be inlined, and juice drops !important from existing inline styles.
 * If inlining throws, the email goes out with the <style> block instead, as it always used to.
 */
function wrapWithEmailStyles(htmlBody: string, emailId?: string): string {
  try {
    const $ = load(emailDocument(htmlBody), {xml: {xmlMode: false, decodeEntities: false}});
    juice.inlineDocument($, EMAIL_PROSE_CSS, {
      applyWidthAttributes: false,
      applyHeightAttributes: false,
      applyAttributesTableElements: false,
    });
    return $.html();
  } catch (error) {
    warnAtMostEveryMinute(
      'inline',
      `[EMAIL] Failed to inline the email styles${emailId ? ` of email ${emailId}` : ''}, sending them in a <style> block:`,
      error,
    );
    return emailDocument(htmlBody, EMAIL_PROSE_CSS);
  }
}

/** Places the (HTML-escaped) preheader at the top of the email body. */
function insertPreheader(html: string, preheader: string): string {
  if (!preheader) {
    return html;
  }

  const block = `<div data-plunk-preheader style="${PREHEADER_STYLE}">${preheader}<span data-plunk-preheader-fill>${PREHEADER_FILL}</span></div>`;
  // Right after <body>; in a document whose <body> is implicit, after <head>, <html> or the
  // doctype so the doctype stays first; in a fragment, at the very start.
  const anchor =
    /<body\b[^>]*>/i.exec(html) ??
    /<\/head>/i.exec(html) ??
    /<html\b[^>]*>/i.exec(html) ??
    /<!doctype[^>]*>/i.exec(html);
  if (!anchor) {
    return `${block}${html}`;
  }

  const at = anchor.index + anchor[0].length;
  return `${html.slice(0, at)}${block}${html.slice(at)}`;
}

/**
 * The HTML of an email body as it is sent, before any per-recipient footer. Visual editor
 * content is wrapped in a styled document; custom HTML (from the HTML editor) already carries its
 * own styles and is used as-is. Either way the preheader, if any, goes at the top.
 */
export function renderBody(content: string, emailId?: string): string {
  const {preheader, body} = splitPreheader(content);
  const wrapped = detectCustomHtmlPatterns(body) ? body : wrapWithEmailStyles(body, emailId);
  const html = insertPreheader(wrapped, preheader);

  const bytes = Buffer.byteLength(html);
  if (bytes > GMAIL_CLIP_WARNING_BYTES) {
    warnAtMostEveryMinute(
      'size',
      `[EMAIL] Email${emailId ? ` ${emailId}` : ''} is ${bytes} bytes before its footer; Gmail clips messages above 102 KB`,
    );
  }

  return html;
}
