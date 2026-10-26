import {BRAND_DEFAULTS, type EmailBrand, isFramedBrand} from './brand.js';
import {EDITOR_BLOCK_CLASSES} from './emailBlocks.js';

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

/**
 * Detects if HTML contains custom patterns that indicate it was written in the HTML editor
 * rather than the visual editor.
 *
 * The TipTap editor loads StarterKit + TextAlign + Color + TextStyle + Link +
 * ResizableImage + EmailButton + EmailDivider (styled <hr>) + EmailSpacer + VariableMention.
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

/** Where the API puts the unsubscribe footer in a framed email, so it sits on the email's background. */
const EMAIL_FOOTER_SLOT = '<!--plunk:footer-->';

/** The rounding of a framed email's column, in px. Outlook for Windows ignores it and squares it. */
export const EMAIL_COLUMN_RADIUS = 12;

// WCAG relative luminance of a `#rrggbb` colour
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

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
        <div style="${width ? `max-width: ${width}px; ` : ''}margin: 0 auto; padding: 24px; background-color: ${contentColor}; border-radius: ${EMAIL_COLUMN_RADIUS}px; text-align: left;">
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
