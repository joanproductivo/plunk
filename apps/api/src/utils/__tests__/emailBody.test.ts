import {load} from 'cheerio/slim';
import signale from 'signale';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {renderBody} from '../emailBody.js';

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

  describe('size', () => {
    it('warns when the email gets close to Gmail clipping', () => {
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      renderBody('<p>A paragraph long enough to add up when repeated many times over.</p>'.repeat(1500));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Gmail clips'));
    });

    it('stays quiet for an ordinary email', () => {
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      renderBody('<p>Hello</p>');

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
