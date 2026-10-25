/**
 * Alignment for blocks that sit alone in a paragraph: images and buttons. An aligned block is
 * wrapped in <p style="text-align: …">, which is what every email client, classic Outlook for
 * Windows included, honours. Left is how such a block renders anyway, so it is stored as no
 * alignment (see EmailTextAlign).
 */
export type BlockAlignment = 'center' | 'right';

// Only centre and right change how a block is laid out; anything else renders left.
export function blockAlignment(textAlign: unknown): BlockAlignment | null {
  return textAlign === 'center' || textAlign === 'right' ? textAlign : null;
}

// Reads back what the blocks write: only the wrapping paragraph carries the alignment.
// `text-align` anywhere else, the block itself included, never moved it and still doesn't.
export function parseBlockAlignment(element: HTMLElement): BlockAlignment | null {
  return element.matches('p') ? blockAlignment(element.style.textAlign) : null;
}

/**
 * A paragraph holding one element matching `selector` and nothing else, so claiming it as that
 * block can never drop text or Liquid tags. Only the paragraph's own text counts: the block's
 * text (a button label) is part of the block. A non-breaking space counts as content (it is
 * often a deliberate spacer). A list item must open with a paragraph, so the paragraph it opens
 * with is left alone: claiming it would push the block, and the rest of the list, out of it.
 */
export function isLoneChildParagraph(element: HTMLElement, selector: string): boolean {
  if (element.parentElement?.tagName === 'LI' && !element.previousElementSibling) {
    return false;
  }

  const ownText = Array.from(element.childNodes)
    .filter(child => child.nodeType === 3)
    .map(child => child.textContent ?? '')
    .join('');

  return (
    element.childElementCount === 1 && element.firstElementChild!.matches(selector) && !/[^ \t\n\r\f]/.test(ownText)
  );
}
