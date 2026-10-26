import {describe, expect, it} from 'vitest';

import {BRAND_DEFAULTS, EMAIL_FONT_FAMILY, EMAIL_FONTS, emailProseCss, toEmailBrand} from '../template/index.js';

/** The declarations of the first rule for `selector`. */
function rule(css: string, selector: string): string {
  const start = `\n${css}`.indexOf(`\n${selector} {\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('emailProseCss', () => {
  it('leaves the preview-only rules out of what is sent', () => {
    const css = emailProseCss();

    expect(css).not.toContain('box-sizing');
    expect(css).not.toContain('quotes');
    expect(css).toContain(`font-family: ${EMAIL_FONT_FAMILY};`);
  });

  it('keeps the box-sizing reset and the quote marks in the preview', () => {
    const css = emailProseCss(BRAND_DEFAULTS, {preview: true});

    expect(css.startsWith('* { box-sizing: border-box; }\nbody {')).toBe(true);
    expect(rule(css, '.prose blockquote')).toContain('quotes: "\\201C""\\201D""\\2018""\\2019";');
  });

  it("puts the brand's colours and font where they belong", () => {
    const css = emailProseCss(
      toEmailBrand({font: 'book-serif', textColor: '#222222', headingColor: '#000000', linkColor: '#0a7c3e'}),
    );

    expect(rule(css, '.prose')).toContain('color: #222222;');
    expect(rule(css, '.prose')).toContain(`font-family: ${EMAIL_FONTS['book-serif']};`);
    expect(rule(css, 'body')).toContain(`font-family: ${EMAIL_FONTS['book-serif']};`);
    expect(rule(css, '.prose a')).toContain('color: #0a7c3e;');
    expect(rule(css, '.prose strong')).toContain('color: #000000;');
    for (const heading of ['h1', 'h2', 'h3', 'h4']) {
      expect(rule(css, `.prose ${heading}`)).toContain('color: #000000;');
    }
    // Quotes, code and tables keep their own colours
    expect(rule(css, '.prose blockquote')).toContain('color: #111827;');
    expect(rule(css, '.prose code')).toContain('color: #111827;');
  });
});
