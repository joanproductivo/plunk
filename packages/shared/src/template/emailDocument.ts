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

/** A full email document around visual editor content. `styleBlock` is only used as a fallback. */
export function emailDocument(htmlBody: string, styleBlock?: string): string {
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
