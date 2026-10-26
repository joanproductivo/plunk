import {describe, expect, it} from 'vitest';

import {BRAND_DEFAULTS, BUTTON_DEFAULTS, sameEmailBrand, toEmailBrand, toProjectBrand} from '../template/index.js';

describe('toEmailBrand', () => {
  it('falls back to the defaults for missing or invalid data', () => {
    for (const value of [undefined, null, 'x', 42, [], {}]) {
      expect(toEmailBrand(value)).toEqual(BRAND_DEFAULTS);
    }
  });

  it('keeps valid values, normalising colours', () => {
    expect(
      toEmailBrand({
        font: 'modern-serif',
        textColor: '#ABC',
        headingColor: 'rgb(0, 0, 0)',
        linkColor: '#0A7C3E',
        backgroundColor: '#F3F4F6',
        contentColor: '#fff',
        contentWidth: 640,
      }),
    ).toEqual({
      font: 'modern-serif',
      textColor: '#aabbcc',
      headingColor: '#000000',
      linkColor: '#0a7c3e',
      backgroundColor: '#f3f4f6',
      contentColor: '#ffffff',
      contentWidth: 640,
    });
  });

  it('never lets anything but known fonts, colours and widths through', () => {
    const brand = toEmailBrand({
      font: 'constructor',
      textColor: 'red; background: url(x)',
      backgroundColor: 'transparent',
      contentWidth: 600.5,
    });

    expect(brand).toEqual(BRAND_DEFAULTS);
  });

  it('ignores values that are not strings, whatever they hold', () => {
    const odd = {toString: 1};

    expect(toEmailBrand({textColor: odd, backgroundColor: {toString: null}})).toEqual(BRAND_DEFAULTS);
    expect(toProjectBrand({button: {textColor: odd}}).button).toEqual(BUTTON_DEFAULTS);
  });

  it('only takes widths between 480 and 800 px', () => {
    expect(toEmailBrand({contentWidth: 479}).contentWidth).toBeNull();
    expect(toEmailBrand({contentWidth: 480}).contentWidth).toBe(480);
    expect(toEmailBrand({contentWidth: 800}).contentWidth).toBe(800);
    expect(toEmailBrand({contentWidth: 801}).contentWidth).toBeNull();
    expect(toEmailBrand({contentWidth: '600'}).contentWidth).toBe(600);
  });
});

describe('toProjectBrand', () => {
  it('adds the button, with its own defaults', () => {
    expect(toProjectBrand({})).toEqual({...BRAND_DEFAULTS, button: BUTTON_DEFAULTS});
    expect(toProjectBrand({button: {shape: 'pill', backgroundColor: '#ff0000'}}).button).toEqual({
      ...BUTTON_DEFAULTS,
      shape: 'pill',
      backgroundColor: '#ff0000',
    });
  });
});

describe('sameEmailBrand', () => {
  it('compares the look, not the button', () => {
    const project = toProjectBrand({textColor: '#000000', button: {shape: 'pill'}});

    expect(sameEmailBrand(project, {...BRAND_DEFAULTS, textColor: '#000000'})).toBe(true);
    expect(sameEmailBrand(project, BRAND_DEFAULTS)).toBe(false);
  });
});
