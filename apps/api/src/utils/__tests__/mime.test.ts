import {describe, expect, it} from 'vitest';

import {encodeHeaderValue, encodeQuotedPrintable, formatMailbox, htmlToPlainText} from '../mime.js';

/**
 * Decode quoted-printable back to a string, so the encoder can be checked on the
 * property that actually matters — that a client round-trips to the original text —
 * rather than on the exact bytes it happens to emit.
 */
function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\n/g, '');

  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const char = withoutSoftBreaks[i] as string;
    if (char === '=') {
      bytes.push(parseInt(withoutSoftBreaks.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe('htmlToPlainText', () => {
  it('keeps link targets alongside their anchor text', () => {
    const text = htmlToPlainText('<p>Please <a href="https://example.com/reset">reset your password</a>.</p>');

    // Both halves have to survive: the anchor text is what the reader understands, the
    // URL is what makes the text part a genuine equivalent of the HTML.
    expect(text).toContain('reset your password');
    expect(text).toContain('https://example.com/reset');
  });

  it('does not repeat the URL when it is already the anchor text', () => {
    const text = htmlToPlainText('<a href="https://example.com">https://example.com</a>');

    expect(text.match(/example\.com/g)).toHaveLength(1);
  });

  it('separates block elements onto their own lines', () => {
    const text = htmlToPlainText('<p>First paragraph</p><p>Second paragraph</p>');

    // Without this, the two paragraphs run together into "First paragraphSecond
    // paragraph" -- the mangled-text shape that spam filters treat as obfuscation.
    expect(text).toMatch(/First paragraph\n+Second paragraph/);
  });

  it('flattens layout tables instead of drawing them', () => {
    const html = '<table><tr><td>Hello</td></tr><tr><td>World</td></tr></table>';
    const text = htmlToPlainText(html);

    expect(text).toContain('Hello');
    expect(text).toContain('World');
    // Plunk's editor emits table-based layout, so ASCII table borders would be noise.
    expect(text).not.toMatch(/[|+]/);
  });

  it('drops images, including tracking pixels', () => {
    const text = htmlToPlainText('<p>Hi</p><img src="https://track.example.com/o.gif" alt="tracker" width="1">');

    expect(text).not.toContain('tracker');
    expect(text).not.toContain('track.example.com');
  });

  it('does not upper-case headings', () => {
    // html-to-text shouts headings by default, which feeds the caps-ratio spam
    // heuristics this conversion exists to stay clear of.
    expect(htmlToPlainText('<h1>Your invoice is ready</h1>')).toContain('Your invoice is ready');
  });

  it('returns nothing for markup with no readable content', () => {
    // Drives the "skip the text part entirely" branch in sendRawEmail.
    expect(htmlToPlainText('<html><body><img src="x.png"></body></html>').trim()).toBe('');
  });
});

describe('encodeQuotedPrintable', () => {
  it('leaves plain ASCII readable', () => {
    // The point of quoted-printable over base64: a human (and a spam filter) can still
    // read the content.
    expect(encodeQuotedPrintable('Hello world')).toBe('Hello world');
  });

  it('escapes the equals sign', () => {
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db');
  });

  it('encodes multi-byte characters one group per byte', () => {
    // é is two UTF-8 bytes (C3 A9). Encoding the code point instead would produce
    // something no decoder can read back.
    expect(encodeQuotedPrintable('café')).toBe('caf=C3=A9');
  });

  it('round-trips emoji and accented text', () => {
    const original = 'Grüße aus München 🎉 — déjà vu';

    expect(decodeQuotedPrintable(encodeQuotedPrintable(original))).toBe(original);
  });

  it('keeps every line within the 76-character limit', () => {
    const encoded = encodeQuotedPrintable('word '.repeat(200));

    for (const line of encoded.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('keeps lines within the limit when the content is all multi-byte', () => {
    // Each character expands to 3 chars per byte here, so the budget is consumed in
    // whole tokens rather than single columns -- the case most likely to overshoot.
    const encoded = encodeQuotedPrintable('日本語のテキスト'.repeat(50));

    for (const line of encoded.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('round-trips content that had to be wrapped', () => {
    const original = `${'a'.repeat(300)} and then ${'ü'.repeat(100)}`;

    expect(decodeQuotedPrintable(encodeQuotedPrintable(original))).toBe(original);
  });

  it('never splits an escape sequence across a line break', () => {
    const encoded = encodeQuotedPrintable('ü'.repeat(200));

    for (const line of encoded.split('\n')) {
      const withoutSoftBreak = line.endsWith('=') ? line.slice(0, -1) : line;
      // A trailing '=' or '=X' would mean an escape was cut in half, and the decoder
      // would read the fragments as literal text.
      expect(withoutSoftBreak).not.toMatch(/=$|=[0-9A-F]$/);
    }
  });

  it('encodes whitespace that would otherwise be stripped at end of line', () => {
    // Intermediate servers strip trailing whitespace, so a literal space here would be
    // silently lost from the recipient's copy.
    expect(encodeQuotedPrintable('trailing ')).toBe('trailing=20');
    expect(encodeQuotedPrintable('trailing\t')).toBe('trailing=09');
  });

  it('preserves whitespace in the middle of a line as-is', () => {
    expect(encodeQuotedPrintable('a b\tc')).toBe('a b\tc');
  });

  it('preserves blank lines between paragraphs', () => {
    const original = 'First\n\nSecond';

    expect(decodeQuotedPrintable(encodeQuotedPrintable(original))).toBe(original);
  });

  it('normalizes CRLF input to a single line ending', () => {
    // Otherwise the CR survives as =0D and the recipient sees a stray character.
    expect(encodeQuotedPrintable('a\r\nb')).toBe('a\nb');
    expect(encodeQuotedPrintable('a\rb')).toBe('a\nb');
  });

  it('handles empty input', () => {
    expect(encodeQuotedPrintable('')).toBe('');
  });
});

/**
 * Decode RFC 2047 "Q" encoded-words back to a string, the way a mail client does:
 * unfold, drop the whitespace between adjacent words, then decode each one.
 */
function decodeEncodedWords(input: string): string {
  return input
    .replace(/\n /g, ' ')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?Q\?([^?]*)\?=/g, (_, payload: string) => decodeQuotedPrintable(payload.replace(/_/g, '=20')));
}

describe('encodeHeaderValue', () => {
  it('leaves plain ASCII untouched', () => {
    expect(encodeHeaderValue('Your order has shipped!')).toBe('Your order has shipped!');
  });

  it('encodes non-ASCII so the header is pure ASCII on the wire', () => {
    const encoded = encodeHeaderValue('¡Novedades de otoño! 🍂');

    expect(encoded).toMatch(/^[\x20-\x7E\n]*$/);
    expect(encoded.startsWith('=?UTF-8?Q?')).toBe(true);
    expect(decodeEncodedWords(encoded)).toBe('¡Novedades de otoño! 🍂');
  });

  it('keeps every encoded-word within 75 characters and every line short', () => {
    const subject = 'Ñandú '.repeat(40) + '👨‍👩‍👧 fin';
    const encoded = encodeHeaderValue(subject);

    for (const line of encoded.split('\n')) {
      expect(line.trim().length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(encoded)).toBe(subject);
  });

  it('never splits the bytes of one character across two encoded-words', () => {
    const encoded = encodeHeaderValue('é'.repeat(30));

    for (const word of encoded.split('\n ')) {
      // Each word must decode on its own, without U+FFFD replacement characters.
      expect(decodeEncodedWords(word)).toMatch(/^é+$/);
    }
  });

  it('turns line breaks into spaces so the value cannot start a new header', () => {
    expect(encodeHeaderValue('Hello\r\nBcc: victim@example.com')).toBe('Hello Bcc: victim@example.com');
    expect(decodeEncodedWords(encodeHeaderValue('Olá\nmundo'))).toBe('Olá mundo');
  });

  it('encodes ASCII that a client could misread as an encoded-word', () => {
    const encoded = encodeHeaderValue('Literal =?UTF-8?Q?x?= text');

    expect(encoded.startsWith('=?UTF-8?Q?')).toBe(true);
    expect(encoded).not.toContain('?Q?x?=');
    expect(decodeEncodedWords(encoded)).toBe('Literal =?UTF-8?Q?x?= text');
  });
});

describe('formatMailbox', () => {
  it('returns the bare address when there is no name', () => {
    expect(formatMailbox('', 'a@example.com')).toBe('a@example.com');
    expect(formatMailbox(undefined, 'a@example.com')).toBe('a@example.com');
    expect(formatMailbox('   ', 'a@example.com')).toBe('a@example.com');
  });

  it('leaves a simple name unquoted', () => {
    expect(formatMailbox('Acme Support', 'a@example.com')).toBe('Acme Support <a@example.com>');
  });

  it('quotes a name with specials, so a comma is not read as a second address', () => {
    expect(formatMailbox('Joan, from Acme', 'a@example.com')).toBe('"Joan, from Acme" <a@example.com>');
    expect(formatMailbox('Acme Inc.', 'a@example.com')).toBe('"Acme Inc." <a@example.com>');
  });

  it('escapes quotes and backslashes inside a quoted name', () => {
    expect(formatMailbox('The "Best" \\ Shop', 'a@example.com')).toBe('"The \\"Best\\" \\\\ Shop" <a@example.com>');
  });

  it('encodes a non-ASCII name, specials included', () => {
    const formatted = formatMailbox('Café, Sabaï', 'a@example.com');

    expect(formatted).toMatch(/^=\?UTF-8\?Q\?[^,]*\?= <a@example\.com>$/);
    expect(decodeEncodedWords(formatted)).toBe('Café, Sabaï <a@example.com>');
  });
});
