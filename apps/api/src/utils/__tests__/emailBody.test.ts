import {buttonStyle, BUTTON_DEFAULTS, readButtonStyle, readSpacerHeight, spacerStyle} from '@plunk/shared';
import {load} from 'cheerio/slim';
import signale from 'signale';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {renderBody} from '../emailBody.js';
import {htmlToPlainText} from '../mime.js';

vi.mock('@plunk/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@plunk/shared')>();
  return {
    ...actual,
    readButtonStyle: vi.fn(actual.readButtonStyle),
    readSpacerHeight: vi.fn(actual.readSpacerHeight),
  };
});

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

  describe('editor buttons', () => {
    const button = (style = buttonStyle(BUTTON_DEFAULTS), href = 'https://example.com', label = 'Shop now') =>
      `<a class="email-button" href="${href}" style="${style}">${label}</a>`;

    it('keeps the button in its aligned paragraph and adds the Outlook spacers inside the link', () => {
      const html = renderBody(`<p style="text-align: center;">${button()}</p>`);

      expect(html).not.toContain('<table');
      expect(html).toMatch(/<p style="[^"]*text-align: center;"><a class="email-button"/);
      // Medium size: 20px either side as 2 hair spaces at 500%, 12px top and bottom as 18pt
      expect(html).toContain(
        '<!--[if mso]><i style="mso-font-width:500%;mso-text-raise:18" hidden>&#8202;&#8202;</i><![endif]-->',
      );
      expect(html).toContain(
        '<span style="max-width: 100%; display: inline-block; line-height: 120%; mso-text-raise: 9px">Shop now</span>',
      );
      expect(html).toContain(
        '<!--[if mso]><i style="mso-font-width:500%" hidden>&#8202;&#8202;&#8203;</i><![endif]-->',
      );
    });

    it('keeps its own colours and padding over the prose link styles, and adds the email font', () => {
      const style = styleOf(renderBody(`<p>${button()}</p>`), 'a');

      expect(style).toMatch(/color: #ffffff;.*font-family: ui-sans-serif/);
      expect(style).toContain('padding: 12px 20px');
      expect(style).toContain('text-decoration: none');
      expect(style).toContain('mso-padding-alt: 0px');
    });

    it('keeps a font of its own without adding the email one', () => {
      const style = styleOf(renderBody(`<p>${button(buttonStyle({...BUTTON_DEFAULTS, font: 'book-serif'}))}</p>`), 'a');

      expect(style).toContain('Iowan Old Style');
      expect(style).not.toContain('ui-sans-serif');
    });

    it('leaves a button sharing its paragraph with text where it is', () => {
      const html = renderBody(`<p>Hi ${button()} there</p>`);

      expect(html).toMatch(/<p style="[^"]*">Hi <a class="email-button"[^>]*><!--\[if mso\]>/);
      expect(html).toContain('</a> there</p>');
    });

    it('drops a link a button may not have, and leaves that button without spacers', () => {
      const html = renderBody(`<p>${button(undefined, 'javascript:alert(1)')}</p>`);

      expect(html).not.toContain('javascript');
      expect(html).not.toContain('[if mso]');
    });

    it('still sends the inlined email when adding the spacers fails', () => {
      vi.mocked(readButtonStyle).mockImplementationOnce(() => {
        throw new Error('broken style');
      });
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      const html = renderBody(`<h1>Hi</h1><p>${button()}</p>`);

      expect(html).not.toContain('<style');
      expect(styleOf(html, 'h1')).toContain('font-weight: 800');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Outlook padding'), expect.any(Error));
    });

    it('keeps the font and colours of a button as Chromium saves it, with rgb() and &quot;', () => {
      const saved =
        '<p><a class="email-button" href="https://example.com" style="display: inline-block; padding: 16px 32px; background-color: rgb(225, 29, 72); color: rgb(255, 255, 255); text-decoration: none; font-weight: 600; line-height: 1.2; border-radius: 999px; font-family: &quot;Iowan Old Style&quot;, &quot;Palatino Linotype&quot;, &quot;URW Palladio L&quot;, P052, serif;">Go</a></p>';

      const style = styleOf(renderBody(saved), 'a');

      expect(style).toContain("font-family: 'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, serif");
      expect(style).not.toContain('undefined');
      expect(style).not.toContain('ui-sans-serif');
      expect(style).toContain('background-color: rgb(225, 29, 72)');
    });

    it('keeps a font written by hand rather than adding the email one', () => {
      const style = styleOf(
        renderBody(`<p>${button(`${buttonStyle(BUTTON_DEFAULTS)} font-family: Georgia;`)}</p>`),
        'a',
      );

      expect(style).toContain('font-family: Georgia');
      expect(style).not.toContain('ui-sans-serif');
    });

    it('treats a < in a label (from contact data, say) as text, not markup', () => {
      const html = renderBody(`<p>${button(undefined, undefined, 'I &lt;3 this')}</p><p>Ana <3</p>`);

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('[if mso]');
    });

    it('reads as label and link in the plain-text part', () => {
      expect(htmlToPlainText(renderBody(`<p>${button()}</p>`))).toBe('Shop now [https://example.com]');
    });
  });

  describe('editor dividers and spacers', () => {
    // A divider and a spacer as Chromium saves them from the editor
    const DIVIDER =
      '<hr style="border-width: 4px 0px 0px; border-style: solid; border-color: rgb(225, 29, 72); margin: 16px 0px;">';
    const spacer = (height = 48) => `<hr class="email-spacer" style="${spacerStyle(height)}">`;

    it("keeps a divider's own style after the prose styles it overrides", () => {
      const style = styleOf(renderBody(`<p>a</p>${DIVIDER}<p>b</p>`), 'hr');

      expect(style).toMatch(/border-top: 1px solid #e5e7eb.*border-width: 4px 0px 0px/);
      expect(style).toMatch(/margin-top: 3em.*margin: 16px 0px/);
      expect(style).toContain('border-color: rgb(225, 29, 72)');
    });

    it('sends a spacer as a div every client keeps at its height', () => {
      const html = renderBody(`<p>a</p>${spacer()}<p>b</p>`);

      expect(html).not.toContain('<hr');
      expect(html).toContain(
        '<div class="email-spacer" style="height:48px;line-height:48px;font-size:1px;mso-line-height-rule:exactly">&#8202;</div>',
      );
    });

    it('writes a hand-written height as a number within bounds, or the default', () => {
      const heightOf = (style: string) =>
        renderBody(`<hr class="email-spacer" style="${style}">`).match(
          /<div class="email-spacer" style="height:(\d+)px/,
        )?.[1];

      expect(heightOf('height: 999px')).toBe('200');
      expect(heightOf('height: 3em')).toBe('32');
      expect(heightOf('height: calc(100px + 1em)')).toBe('32');
      expect(heightOf('margin: 0px')).toBe('32');
    });

    it('still sends the inlined email when converting spacers fails', () => {
      vi.mocked(readSpacerHeight).mockImplementationOnce(() => {
        throw new Error('broken style');
      });
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      const html = renderBody(`<h1>Hi</h1>${spacer()}`);

      expect(styleOf(html, 'h1')).toContain('font-weight: 800');
      expect(styleOf(html, 'hr')).toContain('height: 48px');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('convert spacers'), expect.any(Error));
    });

    it('reads as a rule for a divider and as nothing for a spacer in the plain-text part', () => {
      expect(htmlToPlainText(renderBody(`<p>a</p>${DIVIDER}<p>b</p>`))).toBe(`a\n\n${'-'.repeat(40)}\n\nb`);
      expect(htmlToPlainText(renderBody(`<p>a</p>${spacer()}<p>b</p>`))).toBe('a\n\nb');
      expect(htmlToPlainText(`<p>a</p>${spacer()}<p>b</p>`)).toBe('a\n\nb');
    });
  });

  describe('custom HTML', () => {
    it('sends look-alike buttons and buttons with markup inside as they are', () => {
      const lookAlike = '<p><a class="email-button-primary" href="https://a.com">Go</a></p>';
      const rich = '<p><a class="email-button" href="https://a.com"><strong>Go</strong></a></p>';

      expect(renderBody(lookAlike)).toBe(lookAlike);
      expect(renderBody(rich)).toBe(rich);
    });

    it('sends a look-alike spacer as it is', () => {
      const lookAlike = '<p>a</p><hr class="email-spacer-big" style="height: 48px;">';

      expect(renderBody(lookAlike)).toBe(lookAlike);
    });

    it('checks for buttons in linear time, as the body may hold contact data', () => {
      const hostile = `<p>${'<a class="email-button" '.repeat(4000)}</p>`;

      const start = performance.now();
      renderBody(hostile);

      expect(performance.now() - start).toBeLessThan(500);
    });

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
