import {
  BRAND_DEFAULTS,
  BUTTON_PADDING,
  detectCustomHtmlPatterns,
  EMAIL_COLUMN_PADDING,
  emailDocument,
  emailFontFamily,
  emailProseCss,
  insertFooter,
  type EmailBrand,
  isFramedBrand,
  isSafeButtonHref,
  isSafeVideoHrefAttribute,
  readButtonStyle,
  readSpacerHeight,
  splitEmailMarkers,
} from '@plunk/shared';
import {type CheerioAPI, load} from 'cheerio/slim';
import makeJuiceClient from 'juice/lib/inline.js';
import signale from 'signale';

import {convertBoxes, recolourBoxes, spanFullWidthBoxes} from './emailBoxes.js';

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
 * Word does not always inherit it: the email's font, unless the button has one of its own. A
 * button whose link is not one a button may have loses it.
 */
function addOutlookButtonPadding($: CheerioAPI, emailFont: string): void {
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
    const font = /(^|;)\s*font-family\s*:/i.test(style) ? '' : `; font-family: ${emailFont}`;

    link.attr('style', `${style}${font}; max-width: 100%; mso-padding-alt: 0px`);
    link.html(
      `<!--[if mso]><i style="mso-font-width:${width}%;mso-text-raise:${pt(vertical * 2)}" hidden>${spaces}</i><![endif]-->` +
        `<span style="max-width: 100%; display: inline-block; line-height: 120%; mso-text-raise: ${pt(vertical)}px">${link.html()}</span>` +
        `<!--[if mso]><i style="mso-font-width:${width}%" hidden>${spaces}&#8203;</i><![endif]-->`,
    );
  });
}

/** Videos outside a column of a chosen width go out this wide in Outlook, the usual email width. */
const VIDEO_DEFAULT_WIDTH = 600;

/** Posters taller or wider than this are not a video's, so their height is left to the client. */
const VIDEO_MAX_RATIO = 4;

// A size attribute as written by the editor: a whole number of pixels
const pixels = (value: string | undefined) => (value && /^\d{1,5}$/.test(value) ? Number(value) : 0);

/**
 * Editor videos as Outlook for Windows can render them. Its Word engine sizes images by their
 * width and height attributes, ignoring CSS, so the poster's own size (1280 px) would burst the
 * column: the width becomes the column's (the brand's width less the column's padding, or the
 * usual 600 px), whatever the brand was when the video was inserted, and the height follows the
 * poster's shape. A video whose link is not one a video may have loses it.
 */
function sizeVideos($: CheerioAPI, brand: EmailBrand): void {
  const width = brand.contentWidth ? brand.contentWidth - 2 * EMAIL_COLUMN_PADDING : VIDEO_DEFAULT_WIDTH;
  $('a.email-video').each((_, element) => {
    const link = $(element);
    const image = link.children('img').first();
    const [posterWidth, posterHeight] = [pixels(image.attr('width')), pixels(image.attr('height'))];
    const ratio = posterWidth / posterHeight;
    image.attr('width', String(width));
    if (ratio >= 1 / VIDEO_MAX_RATIO && ratio <= VIDEO_MAX_RATIO) {
      image.attr('height', String(Math.round(width / ratio)));
    } else {
      image.removeAttr('height');
    }

    // Attributes are read undecoded (see wrapWithEmailStyles), so the start's & is still &amp;
    if (!isSafeVideoHrefAttribute(link.attr('href'))) {
      link.removeAttr('href');
    }
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

/**
 * Wraps visual editor content in a document in its brand, with the prose styles inlined.
 *
 * Inlining differs from the preview in two small ways: ::before/::after rules (the backticks
 * around inline code) cannot be inlined, and juice drops !important from existing inline styles.
 * If inlining throws, the email goes out with the <style> block instead, as it always used to.
 */
function wrapWithEmailStyles(htmlBody: string, brand: EmailBrand, emailId?: string): string {
  try {
    // A framed email's content goes in as a fragment of its own, so whatever it holds (an unclosed
    // comment, closing tags from contact data) cannot close the frame or swallow the footer's slot
    const framed = isFramedBrand(brand);
    const $ = load(emailDocument(framed ? '' : htmlBody, brand), {xml: {xmlMode: false, decodeEntities: false}});
    if (framed) {
      $('div.prose').first().html(htmlBody);
    }
    // Browsers serialise quoted font names in a style attribute as &quot;, which juice, reading
    // the text undecoded, would take for the end of a declaration
    $('[style]').each((_, element) => {
      element.attribs.style = element.attribs.style!.replace(/&quot;/g, "'");
    });
    juice.inlineDocument($, emailProseCss(brand), {
      applyWidthAttributes: false,
      applyHeightAttributes: false,
      applyAttributesTableElements: false,
    });
    try {
      recolourBoxes($);
    } catch (error) {
      // Boxes keep the colours the prose styles gave their headings, legible on light backgrounds
      warnAtMostEveryMinute('box', `[EMAIL] Failed to colour boxes${emailId ? ` of email ${emailId}` : ''}:`, error);
    }
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
      addOutlookButtonPadding($, emailFontFamily(brand));
    } catch (error) {
      // Buttons without the spacers still render as buttons everywhere but Outlook for Windows
      warnAtMostEveryMinute(
        'button',
        `[EMAIL] Failed to add Outlook padding to buttons${emailId ? ` of email ${emailId}` : ''}:`,
        error,
      );
    }
    try {
      sizeVideos($, brand);
    } catch (error) {
      // A video at its poster's size still shows everywhere but Outlook for Windows
      warnAtMostEveryMinute('video', `[EMAIL] Failed to size videos${emailId ? ` of email ${emailId}` : ''}:`, error);
    }
    try {
      convertBoxes($, brand);
      spanFullWidthBoxes($, brand);
    } catch (error) {
      // An unconverted box is a div with its background and padding inlined, unpadded only in Outlook
      warnAtMostEveryMinute('box', `[EMAIL] Failed to convert boxes${emailId ? ` of email ${emailId}` : ''}:`, error);
    }
    return $.html();
  } catch (error) {
    warnAtMostEveryMinute(
      'inline',
      `[EMAIL] Failed to inline the email styles${emailId ? ` of email ${emailId}` : ''}, sending them in a <style> block:`,
      error,
    );
    return emailDocument(htmlBody, brand, emailProseCss(brand));
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
 * The HTML of an email body as it is sent, with `footer` (the per-recipient unsubscribe footer,
 * if any) in place. Visual editor content is wrapped in a styled document in its brand; custom
 * HTML (from the HTML editor) already carries its own styles and is used as-is. Either way the
 * preheader, if any, goes at the top.
 */
export function renderBody(content: string, emailId?: string, footer = ''): string {
  const {preheader, brand, body} = splitEmailMarkers(content);
  const custom = detectCustomHtmlPatterns(body);
  const look = brand ?? BRAND_DEFAULTS;
  const wrapped = custom ? body : wrapWithEmailStyles(body, look, emailId);
  const html = insertPreheader(wrapped, preheader);

  const bytes = Buffer.byteLength(html);
  if (bytes > GMAIL_CLIP_WARNING_BYTES) {
    warnAtMostEveryMinute(
      'size',
      `[EMAIL] Email${emailId ? ` ${emailId}` : ''} is ${bytes} bytes before its footer; Gmail clips messages above 102 KB`,
    );
  }

  return insertFooter(html, footer, !custom && isFramedBrand(look));
}
