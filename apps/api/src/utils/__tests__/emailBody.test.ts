import {load} from 'cheerio/slim';
import signale from 'signale';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {renderBody} from '../emailBody.js';
import {htmlToPlainText} from '../mime.js';

vi.mock('cheerio/slim', async importOriginal => {
  const actual = await importOriginal<typeof import('cheerio/slim')>();
  return {...actual, load: vi.fn(actual.load)};
});

/** The style attribute of the first element matching `selector`. */
function styleOf(html: string, selector: string): string {
  const match = html.match(new RegExp(`<${selector}\\b[^>]*\\sstyle="([^"]*)"`));
  return match?.[1] ?? '';
}

describe('renderBody', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('visual editor content', () => {
    it('moves the prose styles into style attributes instead of a <style> block', () => {
      const html = renderBody('<h1>Hello</h1><p>Text with <a href="https://example.com">a link</a></p>');

      expect(html).not.toContain('<style');
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(styleOf(html, 'h1')).toContain('font-weight: 800');
      expect(styleOf(html, 'p')).toContain('margin-top');
      expect(styleOf(html, 'a')).toContain('color: #3b82f6');
    });

    it('sets the font on the prose container too, for clients that drop <body>', () => {
      const html = renderBody('<p>Hello</p>');

      expect(styleOf(html, 'body')).toContain('font-family');
      expect(styleOf(html, 'div')).toContain('font-family');
    });

    it('leaves out the box-sizing reset, which would land on every element', () => {
      const html = renderBody('<p>Hello <strong>world</strong></p>');

      expect(html).not.toContain('box-sizing');
    });

    it('indents the quote and draws its bar, leaving out the quote marks, which cannot be inlined', () => {
      const html = renderBody('<blockquote><p>Quote</p></blockquote>');
      const style = html.match(/<div style="([^"]*font-style: italic[^"]*)"><p/)?.[1] ?? '';

      // Apple Mail overrides <blockquote> margins, so the quote goes out as a <div>
      expect(html).not.toContain('<blockquote');
      expect(html).toContain('Quote</p></div>');

      expect(style).toContain('font-style: italic');
      expect(style).toContain('border-left-style: solid');
      // Explicit, as a <div> has no default indent
      expect(style).toContain('margin-left: 40px');
      expect(style).not.toContain('quotes');
    });

    it('keeps existing inline styles over the stylesheet, so centred images stay centred', () => {
      const html = renderBody(
        '<p style="text-align: center;"><img src="https://example.com/a.png" width="200" class="email-image" style="display: block; margin-left: auto; margin-right: auto;"></p>',
      );

      const imgStyle = styleOf(html, 'img');
      expect(imgStyle).toMatch(/margin-left: auto; margin-right: auto;$/);
      expect(styleOf(html, 'p')).toContain('text-align: center');
    });

    it('keeps text, entities and comments exactly as written', () => {
      const html = renderBody('<p>Imágenes 🎉 ñ &amp; &lt;b&gt; “x”<br>line</p><!-- note -->');

      expect(html).toContain('Imágenes 🎉 ñ &amp; &lt;b&gt; “x”<br>line');
      expect(html).toContain('<!-- note -->');
    });

    it('keeps href query strings intact', () => {
      const html = renderBody('<p><a href="https://example.com/?a=1&amp;b=2">x</a></p>');

      expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    });

    it('falls back to a <style> block when inlining fails', () => {
      vi.mocked(load).mockImplementationOnce(() => {
        throw new Error('parser failure');
      });
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      const html = renderBody('<p>Hello</p>');

      expect(html).toContain('<style>');
      expect(html).toContain('.prose');
      expect(html).toContain('<p>Hello</p>');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to inline'), expect.any(Error));
    });
  });

  describe('custom HTML', () => {
    it('is sent as-is', () => {
      const custom = '<table><tr><td style="color: red">Hi</td></tr></table>';

      expect(renderBody(custom)).toBe(custom);
    });
  });

  describe('preheader', () => {
    const preheader = '<!--plunk:preheader:Hello &amp; welcome-->';

    it('goes right after <body> in a visual editor email, as stored', () => {
      const html = renderBody(`${preheader}<p>Body</p>`);

      expect(html).not.toContain('plunk:preheader');
      expect(html).toMatch(/<body[^>]*><div data-plunk-preheader style="display:none;[^"]*">Hello &amp; welcome<span/);
    });

    it('goes after <body> in custom HTML too', () => {
      const html = renderBody(
        `${preheader}<html><head></head><body class="x"><table><tr><td>Hi</td></tr></table></body></html>`,
      );

      expect(html).toMatch(/^<html><head><\/head><body class="x"><div data-plunk-preheader/);
    });

    it('keeps the doctype first in a document without a <body> tag', () => {
      const html = renderBody(`${preheader}<!DOCTYPE html><html><head><title>x</title></head><table></table></html>`);

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('</head><div data-plunk-preheader');
    });

    it('keeps the doctype first when there is no <html>, <head> or <body> tag', () => {
      const html = renderBody(`${preheader}<!DOCTYPE html><table></table>`);

      expect(html.startsWith('<!DOCTYPE html><div data-plunk-preheader')).toBe(true);
    });

    it('goes first in a custom fragment', () => {
      expect(renderBody(`${preheader}<table></table>`).startsWith('<div data-plunk-preheader')).toBe(true);
    });

    it('stays in the plain-text part without its invisible filler', () => {
      const text = htmlToPlainText(renderBody(`${preheader}<p>Body</p>`));

      expect(text.startsWith('Hello & welcome')).toBe(true);
      expect(text).not.toContain('\u200c');
      expect(text).toContain('Body');
    });
  });

  describe('size', () => {
    it('warns when the email gets close to Gmail clipping', () => {
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      renderBody('<p>A paragraph long enough to add up when repeated many times over.</p>'.repeat(1500));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Gmail clips'));
    });

    it('warns at most once a minute, since a campaign renders once per recipient', () => {
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);
      const long = '<p>A paragraph long enough to add up when repeated many times over.</p>'.repeat(1500);

      renderBody(long, 'email-1');
      renderBody(long, 'email-2');

      // The previous test already warned within this minute
      expect(warn).not.toHaveBeenCalled();
    });

    it('stays quiet for an ordinary email', () => {
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      renderBody('<p>Hello</p>');

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
