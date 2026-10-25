import {describe, expect, it} from 'vitest';

import {
  BUTTON_DEFAULTS,
  BUTTON_FONTS,
  buttonStyle,
  type ButtonStyle,
  isSafeButtonHref,
  normalizeHexColor,
  readButtonStyle,
  toButtonStyle,
} from '../template/index.js';

describe('normalizeHexColor', () => {
  it.each([
    ['#E11D48', '#e11d48'],
    ['#fff', '#ffffff'],
    // How a browser reports an inline colour through the CSSOM
    ['rgb(225, 29, 72)', '#e11d48'],
    [' rgb(0,0,0) ', '#000000'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeHexColor(input)).toBe(expected);
  });

  it.each(['red', '#12345', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 0.5)', 'url(x)', '', null, undefined])(
    'rejects %s',
    input => {
      expect(normalizeHexColor(input)).toBeNull();
    },
  );
});

describe('isSafeButtonHref', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:hi@example.com',
    'tel:+34600000000',
    '#top',
    '{{unsubscribeUrl}}',
    '{% if pro %}https://a.com{% else %}https://b.com{% endif %}',
  ])('allows %s', href => {
    expect(isSafeButtonHref(href)).toBe(true);
  });

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'example.com', '', null])(
    'rejects %s',
    href => {
      expect(isSafeButtonHref(href)).toBe(false);
    },
  );
});

describe('button style', () => {
  const custom: ButtonStyle = {
    backgroundColor: '#e11d48',
    textColor: '#fefefe',
    shape: 'pill',
    size: 'large',
    fullWidth: true,
    font: 'book-serif',
  };

  it('reads back every option it writes', () => {
    expect(readButtonStyle(buttonStyle(custom))).toEqual(custom);
    expect(readButtonStyle(buttonStyle(BUTTON_DEFAULTS))).toEqual(BUTTON_DEFAULTS);
  });

  it('recognises a font after juice turns its double quotes into single ones', () => {
    const stack = BUTTON_FONTS['modern-sans'].replace(/'/g, '"');

    expect(readButtonStyle(`font-family: ${stack}`).font).toBe('modern-sans');
  });

  it('falls back to the defaults for values it does not know', () => {
    expect(readButtonStyle('padding: 3px 7px; border-radius: 12px; font-family: Comic Sans; color: red')).toEqual({
      ...BUTTON_DEFAULTS,
      shape: 'rounded',
    });
    expect(readButtonStyle(null)).toEqual(BUTTON_DEFAULTS);
  });

  it('reads the shape from any radius', () => {
    expect(readButtonStyle('border-radius: 0px').shape).toBe('rectangle');
    expect(readButtonStyle('border-radius: 40px').shape).toBe('pill');
    expect(readButtonStyle('border-radius: 4px').shape).toBe('rounded');
  });

  it('keeps the last value of a property, as juice appends the editor styles after the stylesheet ones', () => {
    expect(readButtonStyle('color: #3b82f6; color: #ffffff').textColor).toBe('#ffffff');
  });

  it('never writes a colour it cannot read', () => {
    expect(buttonStyle({...BUTTON_DEFAULTS, backgroundColor: 'red; display: none'})).toContain(
      `background-color: ${BUTTON_DEFAULTS.backgroundColor}`,
    );
  });
});

describe('toButtonStyle', () => {
  it('keeps known values', () => {
    const style: ButtonStyle = {...BUTTON_DEFAULTS, shape: 'pill', size: 'small', fullWidth: true, font: 'monospace'};

    expect(toButtonStyle(style)).toEqual(style);
  });

  it('drops unknown or hostile values and extra keys', () => {
    expect(
      toButtonStyle({
        size: 'huge',
        shape: '__proto__',
        font: 'toString',
        backgroundColor: 5,
        fullWidth: 'yes',
        textAlign: 'right',
      }),
    ).toEqual(BUTTON_DEFAULTS);
    expect(toButtonStyle(null)).toEqual(BUTTON_DEFAULTS);
    expect(toButtonStyle('nonsense')).toEqual(BUTTON_DEFAULTS);
  });
});
