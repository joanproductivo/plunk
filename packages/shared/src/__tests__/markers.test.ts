import {describe, expect, it} from 'vitest';

import {
  BRAND_DEFAULTS,
  type EmailBrand,
  joinEmailMarkers,
  preheaderToText,
  renderTemplate,
  splitEmailMarkers,
  textToPreheader,
  validateTemplate,
} from '../template/index.js';

const BRAND: EmailBrand = {
  font: 'book-serif',
  textColor: '#222222',
  headingColor: '#000000',
  linkColor: '#0a7c3e',
  backgroundColor: '#f3f4f6',
  contentColor: '#ffffff',
  contentWidth: 600,
};

const join = (preheader: string, body: string, brand: EmailBrand | null = null) =>
  joinEmailMarkers({preheader, brand, body});

describe('preheader', () => {
  it('round-trips text through the stored form', () => {
    const text = 'Save 20% & more <today> "only" --> really';
    const body = join(textToPreheader(text), '<p>Hi</p>');

    const {preheader, body: rest} = splitEmailMarkers(body);
    expect(rest).toBe('<p>Hi</p>');
    expect(preheaderToText(preheader)).toBe(text);
  });

  it('cannot close its comment early', () => {
    const body = join(textToPreheader('a --> <b>bold</b>'), '<p>Hi</p>');

    expect(body.indexOf('-->')).toBe(body.lastIndexOf('-->'));
    expect(body).not.toContain('<b>');
  });

  it('decodes in a single pass', () => {
    // An author who literally types an entity gets it back as typed
    expect(preheaderToText(textToPreheader('&lt;'))).toBe('&lt;');
  });

  it('replaces an existing preheader instead of stacking another', () => {
    const once = join('first', '<p>Hi</p>');
    const twice = join('second', splitEmailMarkers(once).body);

    expect(twice).toBe('<!--plunk:preheader:second--><p>Hi</p>');
  });

  it('removes the preheader when the text is blank', () => {
    expect(textToPreheader('   ')).toBe('');
    expect(join('', splitEmailMarkers('<!--plunk:preheader:old--><p>Hi</p>').body)).toBe('<p>Hi</p>');
  });

  it('leaves a body without markers untouched', () => {
    expect(splitEmailMarkers('<p>Hi</p>')).toEqual({preheader: '', brand: null, body: '<p>Hi</p>'});
  });

  it('only recognises a preheader at the very start of the body', () => {
    const body = '<p>Hi</p><!--plunk:preheader:not this-->';

    expect(splitEmailMarkers(body)).toEqual({preheader: '', brand: null, body});
  });

  it('renders Liquid inside the preheader with the rest of the body', () => {
    const body = join(textToPreheader('Hi {{name ?? "there"}}, {% if plan == "pro" %}pro{% endif %}'), '<p>x</p>');

    expect(validateTemplate(body).valid).toBe(true);
    expect(renderTemplate(body, {name: 'Ana', plan: 'pro'})).toBe('<!--plunk:preheader:Hi Ana, pro--><p>x</p>');
  });
});

describe('brand marker', () => {
  it('round-trips a brand after the preheader', () => {
    const value = join('Hello', '<p>Hi</p>', BRAND);

    expect(value).toBe(
      '<!--plunk:preheader:Hello--><!--plunk:brand:font=book-serif;text=#222222;heading=#000000;link=#0a7c3e;' +
        'background=#f3f4f6;content=#ffffff;width=600--><p>Hi</p>',
    );
    expect(splitEmailMarkers(value)).toEqual({preheader: 'Hello', brand: BRAND, body: '<p>Hi</p>'});
  });

  it('round-trips the defaults, leaving out what is unset', () => {
    const value = join('', '<p>Hi</p>', BRAND_DEFAULTS);

    expect(value).toBe('<!--plunk:brand:text=#374151;heading=#111827;link=#3b82f6;content=#ffffff--><p>Hi</p>');
    expect(splitEmailMarkers(value).brand).toEqual(BRAND_DEFAULTS);
  });

  it('keeps the brand when only the preview text changes', () => {
    const value = join('Old', '<p>Hi</p>', BRAND);
    const {brand, body} = splitEmailMarkers(value);

    // What the "Preview text" field emits
    const next = joinEmailMarkers({preheader: textToPreheader('New'), brand, body});

    expect(splitEmailMarkers(next)).toEqual({preheader: 'New', brand: BRAND, body: '<p>Hi</p>'});
  });

  it('is only recognised right after the preheader, or at the start', () => {
    const before = '<!--plunk:brand:text=#000000--><!--plunk:preheader:Hi--><p>x</p>';
    const later = '<p>x</p><!--plunk:brand:text=#000000-->';

    // A brand before the preheader is read, but the preheader after it is then content
    expect(splitEmailMarkers(before)).toEqual({
      preheader: '',
      brand: {...BRAND_DEFAULTS, textColor: '#000000'},
      body: '<!--plunk:preheader:Hi--><p>x</p>',
    });
    expect(splitEmailMarkers(later)).toEqual({preheader: '', brand: null, body: later});
  });

  it('only takes known keys and valid values, whoever wrote it', () => {
    const value =
      '<!--plunk:brand:font=comic-sans;text=red;heading=#12;link=#abc;width=99999;evil=1;background=#zzzzzz--><p>x</p>';

    expect(splitEmailMarkers(value).brand).toEqual({...BRAND_DEFAULTS, linkColor: '#aabbcc'});
  });

  it('is not a marker when it holds anything a brand cannot', () => {
    // Quotes, braces, spaces and colons cannot appear in a brand, so the comment stays content
    for (const text of ['text=#000000;x="a"', 'text={{name}}', 'text=#000000 ', 'text:#000000', 'TEXT=#000000']) {
      const value = `<!--plunk:brand:${text}--><p>x</p>`;
      expect(splitEmailMarkers(value)).toEqual({preheader: '', brand: null, body: value});
    }
  });

  it('passes through Liquid untouched', () => {
    const value = join('', '<p>{{name}}</p>', BRAND);

    expect(validateTemplate(value).valid).toBe(true);
    expect(renderTemplate(value, {name: 'Ana'})).toBe(join('', '<p>Ana</p>', BRAND));
  });
});
