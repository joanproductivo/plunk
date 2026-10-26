import {
  BUTTON_PADDING,
  EDITOR_BLOCK_CLASSES,
  EMAIL_FONT_FAMILY,
  isSafeButtonHref,
  readButtonStyle,
  readSpacerHeight,
  splitPreheader,
} from '@plunk/shared';
import {type CheerioAPI, load} from 'cheerio/slim';
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

// Whether an `a.email-button` holds markup (another tag before its closing </a>). A linear scan:
// the body may carry contact data, so no regex that can backtrack over attacker-sized input.
function hasRichButton(html: string): boolean {
  const links = html.split(/<a\b/i);
  for (let i = 1; i < links.length; i++) {
    const link = links[i]!;
    const tagEnd = link.indexOf('>');
    if (tagEnd < 0) return false;
    if (!/\bclass\s*=\s*["'][^"']*\bemail-button\b/i.test(link.slice(0, tagEnd))) continue;

    const content = link.slice(tagEnd + 1);
    const next = content.search(/<[a-z!/]/i);
    if (next >= 0 && !/^<\/a>/i.test(content.slice(next))) return true;
  }
  return false;
}

/**
 * Detects if HTML contains custom patterns that indicate it was written in the HTML editor
 * rather than the visual editor. Mirrors the same logic in apps/web/src/lib/emailStyles.ts.
 *
 * The TipTap editor loads StarterKit + TextAlign + Color + TextStyle + Link +
 * ResizableImage + EmailButton + EmailDivider (styled <hr>) + EmailSpacer + VariableMention.
 * TextStyle/Color/Link round-trip <span style="..."> and <a style="..."> markup. This detection
 * therefore PERMITS span + inline styles and only REJECTS markup TipTap cannot represent (tables,
 * divs, forms, embeds, custom attrs, <style> blocks, etc).
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
    // The editor's own blocks, matched exactly (see EDITOR_BLOCK_CLASSES)
    const hasDisallowedClass = classes.some(
      (cls: string) =>
        !EDITOR_BLOCK_CLASSES.includes(cls) && !allowedPrefixes.some((prefix: string) => cls.startsWith(prefix)),
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

  return (
    hasCustomClasses ||
    hasCustomAttributes ||
    hasCustomElements ||
    hasMediaQueries ||
    hasStyleTags ||
    hasRichButton(html)
  );
}

// Outlook's mso-* properties take points.
const pt = (px: number) => (px * 3) / 4;

// Hair spaces scaled with mso-font-width, which cannot exceed 500%: how wide and how many to fill `px`.
function hairSpaces(px: number): [percent: number, count: number] {
  let count = 1;
  while (px / count / 2 > 5) count++;
  return [(px / count / 2) * 100, count];
}

/**
 * Editor buttons as Outlook for Windows can render them. Its Word engine ignores padding and
 * inline-block on links, so, as react-email's Button does (MIT), invisible Outlook-only spacers
 * either side of the label stand in for the horizontal padding and mso-text-raise for the
 * vertical one; every other client keeps the link's own padding. The font goes inline too, as
 * Word does not always inherit it. A button whose link is not one a button may have loses it.
 */
function addOutlookButtonPadding($: CheerioAPI): void {
  $('a.email-button').each((_, element) => {
    const link = $(element);
    if (!isSafeButtonHref(link.attr('href'))) {
      link.removeAttr('href');
      return;
    }

    const button = readButtonStyle(link.attr('style'));
    const [vertical, horizontal] = BUTTON_PADDING[button.size];
    const [width, count] = hairSpaces(horizontal);
    const spaces = '&#8202;'.repeat(count);
    const style = (link.attr('style') ?? '').trim().replace(/;$/, '');
    // Unless the button carries a font of its own
    const font = /(^|;)\s*font-family\s*:/i.test(style) ? '' : `; font-family: ${EMAIL_FONT_FAMILY}`;

    link.attr('style', `${style}${font}; max-width: 100%; mso-padding-alt: 0px`);
    link.html(
      `<!--[if mso]><i style="mso-font-width:${width}%;mso-text-raise:${pt(vertical * 2)}" hidden>${spaces}</i><![endif]-->` +
        `<span style="max-width: 100%; display: inline-block; line-height: 120%; mso-text-raise: ${pt(vertical)}px">${link.html()}</span>` +
        `<!--[if mso]><i style="mso-font-width:${width}%" hidden>${spaces}&#8203;</i><![endif]-->`,
    );
  });
}

/**
 * Editor spacers as every client keeps them, MJML's spacer (MIT): a div holding a hair space, as
 * Outlook for Windows ignores a div's height and goes by its exact line height. The height is
 * written as a number read from the spacer, never copied from the body.
 */
function convertSpacers($: CheerioAPI): void {
  $('hr.email-spacer').each((_, element) => {
    const height = readSpacerHeight($(element).attr('style'));
    $(element).replaceWith(
      `<div data-plunk-spacer style="height:${height}px;line-height:${height}px;font-size:1px;mso-line-height-rule:exactly">&#8202;</div>`,
    );
  });
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
    // Browsers serialise quoted font names in a style attribute as &quot;, which juice, reading
    // the text undecoded, would take for the end of a declaration
    $('[style]').each((_, element) => {
      element.attribs.style = element.attribs.style!.replace(/&quot;/g, "'");
    });
    juice.inlineDocument($, EMAIL_PROSE_CSS, {
      applyWidthAttributes: false,
      applyHeightAttributes: false,
      applyAttributesTableElements: false,
    });
    // Apple Mail styles <blockquote> as quoted reply text and overrides its margins, even inline,
    // so a quote from the editor goes out as a <div> with the same styles
    $('blockquote').each((_, element) => {
      element.tagName = 'div';
    });
    try {
      convertSpacers($);
    } catch (error) {
      // An unconverted spacer is an invisible <hr> of the same height, which most clients keep
      warnAtMostEveryMinute(
        'spacer',
        `[EMAIL] Failed to convert spacers${emailId ? ` of email ${emailId}` : ''}:`,
        error,
      );
    }
    try {
      addOutlookButtonPadding($);
    } catch (error) {
      // Buttons without the spacers still render as buttons everywhere but Outlook for Windows
      warnAtMostEveryMinute(
        'button',
        `[EMAIL] Failed to add Outlook padding to buttons${emailId ? ` of email ${emailId}` : ''}:`,
        error,
      );
    }
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
