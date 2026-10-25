import {describe, expect, it} from 'vitest';

import {
  preheaderToText,
  renderTemplate,
  splitPreheader,
  textToPreheader,
  validateTemplate,
  withPreheader,
} from '../template/index.js';

describe('preheader', () => {
  it('round-trips text through the stored form', () => {
    const text = 'Save 20% & more <today> "only" --> really';
    const body = withPreheader(textToPreheader(text), '<p>Hi</p>');

    const {preheader, body: rest} = splitPreheader(body);
    expect(rest).toBe('<p>Hi</p>');
    expect(preheaderToText(preheader)).toBe(text);
  });

  it('cannot close its comment early', () => {
    const body = withPreheader(textToPreheader('a --> <b>bold</b>'), '<p>Hi</p>');

    expect(body.indexOf('-->')).toBe(body.lastIndexOf('-->'));
    expect(body).not.toContain('<b>');
  });

  it('decodes in a single pass', () => {
    // An author who literally types an entity gets it back as typed
    expect(preheaderToText(textToPreheader('&lt;'))).toBe('&lt;');
  });

  it('replaces an existing preheader instead of stacking another', () => {
    const once = withPreheader('first', '<p>Hi</p>');
    const twice = withPreheader('second', once);

    expect(twice).toBe('<!--plunk:preheader:second--><p>Hi</p>');
  });

  it('removes the preheader when the text is blank', () => {
    expect(textToPreheader('   ')).toBe('');
    expect(withPreheader('', '<!--plunk:preheader:old--><p>Hi</p>')).toBe('<p>Hi</p>');
  });

  it('leaves a body without a preheader untouched', () => {
    expect(splitPreheader('<p>Hi</p>')).toEqual({preheader: '', body: '<p>Hi</p>'});
  });

  it('only recognises a preheader at the very start of the body', () => {
    const body = '<p>Hi</p><!--plunk:preheader:not this-->';

    expect(splitPreheader(body)).toEqual({preheader: '', body});
  });

  it('renders Liquid inside the preheader with the rest of the body', () => {
    const body = withPreheader(
      textToPreheader('Hi {{name ?? "there"}}, {% if plan == "pro" %}pro{% endif %}'),
      '<p>x</p>',
    );

    expect(validateTemplate(body).valid).toBe(true);
    expect(renderTemplate(body, {name: 'Ana', plan: 'pro'})).toBe('<!--plunk:preheader:Hi Ana, pro--><p>x</p>');
  });
});
