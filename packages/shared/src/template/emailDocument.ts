import {BRAND_DEFAULTS, type EmailBrand, isFramedBrand} from './brand.js';
import {luminance} from './color.js';
import {EDITOR_BLOCK_CLASSES} from './emailBlocks.js';
import {isSafeVideoHrefAttribute} from './emailVideo.js';

/**
 * The document visual editor emails go out in, shared by the dashboard's previews and the API,
 * and how to tell them from custom HTML, which goes out as it is.
 */

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

// Whether an `a.email-video` is not one the editor writes: a video link, its one href in double
// quotes, holding a single image with a source and nothing else. The visual editor would drop the
// rest, so it stays custom HTML. A linear scan, as hasRichButton.
function hasForeignVideo(html: string): boolean {
  const links = html.split(/<a\b/i);
  for (let i = 1; i < links.length; i++) {
    const link = links[i]!;
    const tagEnd = link.indexOf('>');
    // An unclosed <a is no link; the scan goes on to the next one
    if (tagEnd < 0) continue;
    const tag = link.slice(0, tagEnd);
    if (!/\bclass\s*=\s*["'][^"']*\bemail-video\b/i.test(tag)) continue;

    // Browsers follow the first href however it is quoted, so a second one, or one hidden in
    // another attribute's value, would be checked instead of it
    if (tag.match(/\shref\s*=/gi)?.length !== 1) return true;
    const hrefAt = /\shref\s*=\s*"/i.exec(tag);
    const hrefStart = hrefAt ? hrefAt.index + hrefAt[0].length : -1;
    const hrefEnd = hrefAt ? tag.indexOf('"', hrefStart) : -1;
    if (hrefEnd < 0 || !isSafeVideoHrefAttribute(tag.slice(hrefStart, hrefEnd))) return true;

    const content = link.slice(tagEnd + 1);
    const end = content.search(/<\/a>/i);
    const inner = (end < 0 ? content : content.slice(0, end)).trim();
    const isLoneImage =
      /^<img\b/i.test(inner) &&
      inner.indexOf('>') === inner.length - 1 &&
      inner.indexOf('<', 1) < 0 &&
      /\ssrc\s*=/i.test(inner);
    if (!isLoneImage) return true;
  }
  return false;
}

// The one <div> the editor writes: a box, exactly as it serialises one (see @plunk/shared emailBox)
const BOX_TAG = /^\s+class="email-box( email-box-full)?"(\s+style="[^"<>]*")?\s*$/;

// Whether a <div> is anything but an editor box at the top of the email: any other div, however
// close (other attributes, other quotes, a box inside a box), is custom HTML. A linear scan, as
// hasRichButton: the body may carry contact data.
function hasForeignDiv(html: string): boolean {
  const parts = html.split(/(<\/?div\b)/i);
  let depth = 0;
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i]![1] === '/') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const rest = parts[i + 1]!;
    const tagEnd = rest.indexOf('>');
    if (tagEnd < 0 || depth > 0 || !BOX_TAG.test(rest.slice(0, tagEnd))) return true;
    depth++;
  }
  return false;
}

/**
 * Detects if HTML contains custom patterns that indicate it was written in the HTML editor
 * rather than the visual editor.
 *
 * The TipTap editor loads StarterKit + TextAlign + Color + TextStyle + Link +
 * ResizableImage + EmailButton + EmailDivider (styled <hr>) + EmailSpacer + EmailVideo + EmailBox (a
 * <div class="email-box">, the only div it writes) + VariableMention.
 * TextStyle/Color/Link round-trip <span style="..."> and <a style="..."> markup. This detection
 * therefore PERMITS span + inline styles and only REJECTS markup TipTap cannot represent (tables,
 * divs, forms, embeds, custom attrs, <style> blocks, etc).
 */
export function detectCustomHtmlPatterns(html: string): boolean {
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
  // <span> is intentionally excluded -- TipTap's TextStyle extension handles it, and <div> is
  // checked on its own, as the editor writes one (see hasForeignDiv).
  const hasCustomElements =
    /<(?:section|article|header|footer|nav|aside|main|table|tr|td|th|tbody|thead|tfoot|colgroup|col|form|input|button|select|textarea|iframe|video|audio|svg|object|embed|details|summary|dialog)\b/i.test(
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
    hasRichButton(html) ||
    hasForeignVideo(html) ||
    hasForeignDiv(html)
  );
}

/**
 * Text for an attribute of visual editor content, such as an image's alt text, that never makes
 * it read as custom HTML: without < or >, which would read as markup, and with what
 * detectCustomHtmlPatterns looks for anywhere in the HTML (`data-`, `aria-`, `role=`, `id=`,
 * `class=`, `@media`) broken by a non-breaking hyphen or an invisible space, so it reads the same.
 */
export function visualAttributeText(text: string): string {
  return text
    .replace(/[<>]/g, '')
    .replace(/(data|aria)-/gi, '$1\u2011')
    .replace(/\b(role|id|class)(\s*=)/gi, '$1\u200b$2')
    .replace(/@media/gi, '@\u200bmedia')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where the API puts the unsubscribe footer in a framed email, so it sits on the email's background. */
const EMAIL_FOOTER_SLOT = '<!--plunk:footer-->';

/** The rounding of a framed email's column, in px. Outlook for Windows ignores it and squares it. */
export const EMAIL_COLUMN_RADIUS = 12;

/** The padding of a framed email's column, in px, on each side of its content. */
export const EMAIL_COLUMN_PADDING = 24;

/**
 * Whether the unsubscribe footer, whose text is #404040 (see EmailService.compile), reads on
 * `color` at WCAG's 4.5:1. On a darker content colour it gets a white background of its own:
 * however the brand looks, the way out of the list stays legible.
 */
export function footerReadableOn(color: string): boolean {
  return (luminance(color) + 0.05) / (luminance('#404040') + 0.05) >= 4.5;
}

/**
 * A full email document around visual editor content. `styleBlock` is for the preview, and as a
 * fallback when sending cannot inline it.
 *
 * In a framed brand the content sits in a centred column on the background, as MJML lays emails
 * out (MIT): the background on an outer table, since Gmail drops <body>'s styles; the width as the
 * column's max-width, which narrower screens shrink, and as an Outlook-only table, since Outlook
 * for Windows ignores max-width. The footer goes at the end of the column, under the content.
 */
export function emailDocument(htmlBody: string, brand: EmailBrand = BRAND_DEFAULTS, styleBlock?: string): string {
  const head = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${styleBlock ? `\n  <style>\n${styleBlock}\n  </style>` : ''}
</head>`;

  if (!isFramedBrand(brand)) {
    return `${head}
<body>
  <div class="prose prose-sm max-w-none">
    ${htmlBody}
  </div>
</body>
</html>`;
  }

  const {backgroundColor: background, contentColor, contentWidth: width} = brand;
  const outer = background ? ` bgcolor="${background}" style="background-color: ${background};"` : '';
  return `${head}
<body>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${outer}>
    <tr>
      <td align="center" style="padding: 16px;">${
        width
          ? `\n        <!--[if mso]><table role="presentation" width="${width}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
          : ''
      }
        <div style="${width ? `max-width: ${width}px; ` : ''}margin: 0 auto; padding: ${EMAIL_COLUMN_PADDING}px; background-color: ${contentColor}; border-radius: ${EMAIL_COLUMN_RADIUS}px; text-align: left;">
          <div class="prose prose-sm max-w-none">
            ${htmlBody}
          </div>
          ${footerReadableOn(contentColor) ? EMAIL_FOOTER_SLOT : `<div style="background-color: #ffffff; padding: 8px 16px;">${EMAIL_FOOTER_SLOT}</div>`}
        </div>${width ? '\n        <!--[if mso]></td></tr></table><![endif]-->' : ''}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Places the footer (unsubscribe link and badge) in a framed email's slot, so it sits on the
 * email's background, or else before the last closing body tag, or at the end. The slot is only
 * looked for in documents framed here, after their content: contact data in the body cannot
 * move the footer. An earlier </body> can come from contact data inside the hidden preheader.
 */
export function insertFooter(html: string, footer: string, framed: boolean): string {
  const slot = framed ? html.lastIndexOf(EMAIL_FOOTER_SLOT) : -1;
  if (slot !== -1) {
    return `${html.slice(0, slot)}${footer}${html.slice(slot + EMAIL_FOOTER_SLOT.length)}`;
  }

  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyEnd !== -1) {
    return `${html.slice(0, bodyEnd)}${footer}${html.slice(bodyEnd)}`;
  }
  return `${html}${footer}`;
}
