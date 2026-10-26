import {
  buttonStyle,
  BUTTON_DEFAULTS,
  detectCustomHtmlPatterns,
  type EmailBrand,
  EMAIL_FONTS,
  isFullWidthBox,
  isSafeVideoHrefAttribute,
  joinEmailMarkers,
  readButtonStyle,
  readSpacerHeight,
  spacerStyle,
  toEmailBrand,
} from '@plunk/shared';
import {load} from 'cheerio/slim';
import signale from 'signale';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {renderBody} from '../emailBody.js';
import {htmlToPlainText} from '../mime.js';

vi.mock('@plunk/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@plunk/shared')>();
  return {
    ...actual,
    detectCustomHtmlPatterns: vi.fn(actual.detectCustomHtmlPatterns),
    isFullWidthBox: vi.fn(actual.isFullWidthBox),
    isSafeVideoHrefAttribute: vi.fn(actual.isSafeVideoHrefAttribute),
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
        '<div data-plunk-spacer style="height:48px;line-height:48px;font-size:1px;mso-line-height-rule:exactly">&#8202;</div>',
      );
    });

    it('writes a hand-written height as a number within bounds, or the default', () => {
      const heightOf = (style: string) =>
        renderBody(`<hr class="email-spacer" style="${style}">`).match(
          /<div data-plunk-spacer style="height:(\d+)px/,
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

  describe('editor videos', () => {
    const image = (width = 1280, height = 720) =>
      `<img class="email-image" src="https://files.example.com/youtube-abc.jpg" alt="The video" width="${width}" height="${height}" style="display: block; width: 100%; height: auto; margin: 0px; border: 0px; border-radius: 12px;">`;
    const video = (inner = image(), href = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s') =>
      `<p style="text-align: center;"><a class="email-video" href="${href}" style="text-decoration: none;">${inner}</a></p>`;
    const imageTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? '';

    it('sends the poster 600 px wide in Outlook, keeping its own style over the prose one', () => {
      const html = renderBody(`<p>Hi</p>${video()}`);
      const img = imageTag(html);

      expect(html).toContain('<a class="email-video" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s"');
      expect(img).toContain('width="600" height="338"');
      expect(img).toMatch(/margin-top: [^;]+;.*margin: 0px; border: 0px; border-radius: 12px;/);
      expect(img).toContain('width: 100%;');
      expect(html).toMatch(/<a class="email-video" [^>]*style="[^"]*text-decoration: none;"/);
    });

    it("sends it as wide as a framed brand's column, keeping the poster's shape", () => {
      const body = video(image(480, 360));
      const html = renderBody(
        joinEmailMarkers({preheader: '', brand: toEmailBrand({backgroundColor: '#f3f4f6', contentWidth: 700}), body}),
      );

      expect(imageTag(html)).toContain('width="652" height="489"');
    });

    it.each([
      ['no size of its own', ''],
      ['only a width', ' width="1280"'],
      ['a size that is not whole pixels', ' width="1e3" height="720"'],
      ['a shape no video has', ' width="1" height="900"'],
    ])('sends a poster with %s at the column width, its height left to the client', (_, size) => {
      const img = imageTag(renderBody(video(image().replace(/ width="1280" height="720"/, size))));

      expect(img).toContain('width="600"');
      expect(img).not.toContain('height=');
    });

    it('drops a link that is not one a video may have, still sizing the poster', () => {
      vi.mocked(detectCustomHtmlPatterns).mockReturnValueOnce(false);

      const html = renderBody(video(image(), 'javascript:alert(1)'));

      expect(html).toContain('<a class="email-video" style=');
      expect(html).not.toContain('javascript:');
      expect(imageTag(html)).toContain('width="600" height="338"');
    });

    it('still sends the inlined email when sizing videos fails', () => {
      vi.mocked(isSafeVideoHrefAttribute).mockImplementationOnce(() => {
        throw new Error('broken link');
      });
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      const html = renderBody(`<h1>Hi</h1>${video()}`);

      expect(styleOf(html, 'h1')).toContain('font-weight: 800');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('size videos'), expect.any(Error));
    });

    it('reads as the link to the video in the plain-text part', () => {
      expect(htmlToPlainText(renderBody(`<p>a</p>${video()}<p>b</p>`))).toBe(
        'a\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s\n\nb',
      );
    });
  });

  describe('editor boxes', () => {
    const box = (inner: string, {full = false, style = 'background-color: #111827; color: #ffffff;'} = {}) =>
      `<div class="email-box${full ? ' email-box-full' : ''}" style="${style}">${inner}</div>`;
    const framed = (body: string, brand: Partial<EmailBrand> = {backgroundColor: '#f3f4f6', contentWidth: 600}) =>
      joinEmailMarkers({preheader: '', brand: toEmailBrand(brand), body});
    const cellStyle = (html: string) => html.match(/<td bgcolor="[^"]*" style="([^"]*)"/)?.[1] ?? '';

    it('sends a box as a one-cell table with its background, padding and font on the cell', () => {
      const html = renderBody(`<p>a</p>${box('<p>Inside</p>')}<p>b</p>`);

      expect(html).not.toContain('email-box');
      expect(html).toContain('<table role="presentation" data-plunk-box="inset" width="100%"');
      expect(html).toContain('<td bgcolor="#111827"');
      expect(cellStyle(html)).toMatch(
        /^background-color: #111827; color: #ffffff; padding: 16px; border-radius: 12px; font-family: ui-sans-serif.*; font-size: 14px; line-height: 1\.7142857;$/,
      );
      expect(html).toMatch(/<p style="margin-top: 0; margin-bottom: 0;">Inside<\/p>/);
    });

    it("gives headings, bold text, code and quotes the box's text colour, links keeping theirs", () => {
      const html = renderBody(
        box(
          '<h2>Title</h2><p><strong>Bold</strong> <code>x</code> <a href="https://a.com">link</a></p><blockquote><p>Q</p></blockquote>',
        ),
      );

      expect(styleOf(html, 'h2')).toMatch(/color: #ffffff$/);
      expect(styleOf(html, 'strong')).toMatch(/color: #ffffff$/);
      expect(styleOf(html, 'code')).toMatch(/color: #ffffff$/);
      expect(styleOf(html, 'a')).toContain('color: #3b82f6');
      // The quote, sent as a div, with its text and border in the box's colour
      expect(html).toMatch(/<div style="[^"]*color: #ffffff; border-left-color: #ffffff">/);
    });

    it('writes colours as read from the box, never copied from it', () => {
      const html = renderBody(
        box('<p>a</p>', {
          style: 'background-color: rgb(1, 2, 3); color: red; background-image: url(https://x.example)',
        }),
      );

      expect(html).toContain('<td bgcolor="#010203"');
      expect(cellStyle(html)).toContain('color: #374151;');
      expect(cellStyle(html)).not.toContain('url(');
    });

    it('sends a full-width box square, and across the column without a brand only as wide as the text', () => {
      const html = renderBody(`<p>a</p>${box('<p>Inside</p>', {full: true})}`);

      expect(cellStyle(html)).toContain('padding: 24px; border-radius: 0px;');
      expect(html).not.toContain('padding: 0 24px');
    });

    it("moves a framed column's side padding onto what is around a full-width box, and onto the footer", () => {
      const html = renderBody(
        framed(`<p>Before</p>${box('<p>Band</p>', {full: true})}<p>After</p>`),
        undefined,
        '<p>Unsubscribe</p>',
      );

      expect(html).toContain('border-radius: 12px; text-align: left; padding: 24px 0">');
      expect(html).toMatch(
        /<div style="padding: 0 24px;">\s*<p[^>]*>Before<\/p>\s*<\/div>\s*<table role="presentation" data-plunk-box="full"/,
      );
      expect(html).toMatch(/<\/table>\s*<div style="padding: 0 24px;">\s*<p[^>]*>After<\/p>\s*<\/div>/);
      // The footer stays in its slot, in the column, with the content's padding
      expect(html).toMatch(/<div style="padding: 0 24px;"><p>Unsubscribe<\/p><\/div>\s*<\/div>\s*<!--\[if mso\]>/);
    });

    it('leaves a framed column as it is around inset boxes', () => {
      const html = renderBody(framed(box('<p>Card</p>')));

      expect(html).toContain('padding: 24px; background-color: #ffffff; border-radius: 12px; text-align: left;">');
      expect(html).not.toContain('padding: 0 24px');
    });

    it('fits images in a box to its width in Outlook', () => {
      const image = (width: number) =>
        `<p><img src="https://x.example/a.png" width="${width}" height="${width / 2}" class="email-image"></p>`;
      const widthOf = (html: string) =>
        html
          .match(/<img [^>]*width="(\d+)" height="(\d+)"/)!
          .slice(1)
          .map(Number);

      // A 600 px column holds 552 px of text: an inset box 520, a full-width one 552
      expect(widthOf(renderBody(framed(box(image(552)))))).toEqual([520, 260]);
      expect(widthOf(renderBody(framed(box(image(552), {full: true}))))).toEqual([552, 276]);
      expect(widthOf(renderBody(framed(box(image(400)))))).toEqual([400, 200]);
      // Without a brand width, as wide as 600 px less the box's padding
      expect(widthOf(renderBody(box(image(600))))).toEqual([568, 284]);
    });

    it('still sends the inlined email when converting boxes fails, the box as a styled div', () => {
      vi.mocked(isFullWidthBox).mockImplementationOnce(() => {
        throw new Error('broken box');
      });
      const warn = vi.spyOn(signale, 'warn').mockImplementation(() => undefined);

      const html = renderBody(`<h1>Hi</h1>${box('<p>Inside</p>')}`);

      expect(styleOf(html, 'h1')).toContain('font-weight: 800');
      expect(html).toContain(
        '<div class="email-box" style="padding: 16px; border-radius: 12px; margin-top: 16px; margin-bottom: 16px; background-color: #111827; color: #ffffff;">',
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('convert boxes'), expect.any(Error));
    });

    it('reads as its content in the plain-text part', () => {
      expect(htmlToPlainText(renderBody(`<p>a</p>${box('<h2>Title</h2><p>Text</p>')}<p>b</p>`))).toBe(
        'a\n\n\nTitle\n\nText\n\nb',
      );
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

  describe('brands', () => {
    const branded = (
      brand: Partial<EmailBrand>,
      body = '<h1>Hi</h1><p>Text with <a href="https://a.com">a link</a></p>',
    ) => joinEmailMarkers({preheader: '', brand: toEmailBrand(brand), body});

    it("inlines the brand's font and colours", () => {
      const html = renderBody(
        branded({font: 'book-serif', textColor: '#222222', headingColor: '#000000', linkColor: '#0a7c3e'}),
      );

      expect(styleOf(html, 'div class="prose prose-sm max-w-none')).toContain('color: #222222;');
      expect(styleOf(html, 'div class="prose prose-sm max-w-none')).toContain(
        `font-family: ${EMAIL_FONTS['book-serif']}`,
      );
      expect(styleOf(html, 'h1')).toContain('color: #000000;');
      expect(styleOf(html, 'a')).toContain('color: #0a7c3e;');
      expect(html).not.toContain('plunk:brand');
    });

    it('sends a brand without background or width in the same document as before', () => {
      const html = renderBody(branded({textColor: '#222222'}), undefined, '<p>footer</p>');

      expect(html).not.toContain('<table');
      expect(html).toMatch(/<p>footer<\/p><\/body>\s*<\/html>$/);
    });

    it('draws the background on an outer table and centres a column of the chosen width', () => {
      const html = renderBody(branded({backgroundColor: '#f3f4f6', contentColor: '#fffbeb', contentWidth: 600}));

      expect(html).toContain(
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color: #f3f4f6;">',
      );
      expect(html).toContain('<!--[if mso]><table role="presentation" width="600" align="center"');
      expect(html).toContain(
        '<div style="max-width: 600px; margin: 0 auto; padding: 24px; background-color: #fffbeb; border-radius: 12px; text-align: left;">',
      );
      expect(styleOf(html, 'body')).toContain('padding: 0;');
      expect(styleOf(html, 'body')).toContain('background-color: #f3f4f6;');
      // The prose styles stay inside the column, off the layout tables
      expect(styleOf(html, 'td')).toBe('padding: 16px;');
    });

    it('puts the footer at the end of the column, and leaves no slot behind without one', () => {
      const withFooter = renderBody(branded({backgroundColor: '#f3f4f6'}), undefined, '<p>footer</p>');
      const without = renderBody(branded({backgroundColor: '#f3f4f6'}));

      expect(withFooter).toMatch(/<\/div>\s*<p>footer<\/p>\s*<\/div>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/);
      expect(without).not.toContain('plunk:footer');
    });

    it('keeps the footer legible on a dark content colour', () => {
      const light = renderBody(
        branded({backgroundColor: '#000000', contentColor: '#ffffff'}),
        undefined,
        '<p>footer</p>',
      );
      const dark = renderBody(
        branded({backgroundColor: '#000000', contentColor: '#1f2937'}),
        undefined,
        '<p>footer</p>',
      );

      expect(light).not.toContain('<div style="background-color: #ffffff; padding: 8px 16px;">');
      expect(dark).toContain('<div style="background-color: #ffffff; padding: 8px 16px;"><p>footer</p></div>');
    });

    it('keeps the footer out of reach of the content it follows', () => {
      // As contact data rendered by Liquid could leave the body: an unclosed comment, or closing
      // tags followed by a hidden element
      for (const body of ['<p>a</p><!-- open', '<p>a</p></div></div><span style="display:none">']) {
        for (const brand of [{backgroundColor: '#eeeeee'}, {contentWidth: 600}]) {
          const html = renderBody(branded(brand, body), undefined, '<p id="footer">footer</p>');
          const footer = html.indexOf('<p id="footer">');
          const before = html.slice(0, footer);

          expect(footer).toBeGreaterThan(-1);
          // Not inside a comment, nor inside the hidden span
          expect(before.lastIndexOf('<!--')).toBeLessThanOrEqual(before.lastIndexOf('-->'));
          expect(before.lastIndexOf('<span')).toBeLessThanOrEqual(before.lastIndexOf('</span>'));
        }
      }
    });

    it('keeps entities in a framed email exactly as written', () => {
      const html = renderBody(branded({contentWidth: 600}, '<p>Im&aacute;genes &amp; &lt;b&gt; “x”</p>'));

      expect(html).toContain('Im&aacute;genes &amp; &lt;b&gt; “x”</p>');
    });

    it("gives buttons without a font of their own the brand's font", () => {
      const html = renderBody(
        branded(
          {font: 'modern-serif'},
          `<p><a class="email-button" href="https://a.com" style="${buttonStyle(BUTTON_DEFAULTS)}">Go</a></p>`,
        ),
      );

      expect(styleOf(html, 'a')).toContain(`font-family: ${EMAIL_FONTS['modern-serif']}`);
    });

    it('ignores the brand of custom HTML, which carries its own styles', () => {
      const custom = '<table><tr><td style="color: red">Hi</td></tr></table>';

      expect(renderBody(branded({backgroundColor: '#000000'}, custom))).toBe(custom);
    });

    it('falls back to a <style> block in the brand when inlining fails', () => {
      vi.spyOn(signale, 'warn').mockImplementation(() => undefined);
      vi.mocked(load).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const html = renderBody(branded({backgroundColor: '#f3f4f6', linkColor: '#0a7c3e'}));

      expect(html).toContain('<style>');
      expect(html).toContain('color: #0a7c3e;');
      expect(html).toContain('bgcolor="#f3f4f6"');
    });
  });
});
