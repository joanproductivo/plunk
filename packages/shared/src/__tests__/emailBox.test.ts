import {describe, expect, it} from 'vitest';

import {
  BOX_DEFAULTS,
  boxClass,
  boxStyle,
  contrastRatio,
  isFullWidthBox,
  readBoxColors,
  suggestedTextColor,
} from '../template/index.js';

describe('contrastRatio', () => {
  it('measures as WCAG does, in either order', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBe(1);
    expect(contrastRatio('#374151', '#f3f4f6')).toBeCloseTo(9.37, 1);
  });
});

describe('box styles', () => {
  it('reads back the colours it writes', () => {
    const style = boxStyle({backgroundColor: '#111827', textColor: '#ffffff'});

    expect(style).toBe('background-color: #111827; color: #ffffff;');
    expect(readBoxColors(style)).toEqual({backgroundColor: '#111827', textColor: '#ffffff'});
  });

  it('reads colours as a browser reports them, and anything else as the defaults', () => {
    expect(readBoxColors('background-color: rgb(17, 24, 39); color: rgb(255, 255, 255)')).toEqual({
      backgroundColor: '#111827',
      textColor: '#ffffff',
    });
    expect(readBoxColors('background-color: url(x); color: red')).toEqual({
      backgroundColor: BOX_DEFAULTS.backgroundColor,
      textColor: BOX_DEFAULTS.textColor,
    });
    expect(readBoxColors(null)).toEqual({
      backgroundColor: BOX_DEFAULTS.backgroundColor,
      textColor: BOX_DEFAULTS.textColor,
    });
  });

  it('keeps its width in its class', () => {
    expect(boxClass(false)).toBe('email-box');
    expect(boxClass(true)).toBe('email-box email-box-full');
    expect(isFullWidthBox('email-box email-box-full')).toBe(true);
    expect(isFullWidthBox('email-box')).toBe(false);
    expect(isFullWidthBox(undefined)).toBe(false);
  });
});

describe('suggestedTextColor', () => {
  it("keeps the brand's text colour where it reads", () => {
    expect(suggestedTextColor('#f3f4f6', '#374151')).toBe('#374151');
    expect(suggestedTextColor('#fef3c7', '#374151')).toBe('#374151');
  });

  it('suggests white on dark backgrounds and dark text on light ones the brand does not read on', () => {
    expect(suggestedTextColor('#111827', '#374151')).toBe('#ffffff');
    expect(suggestedTextColor('#1d4ed8', '#374151')).toBe('#ffffff');
    expect(suggestedTextColor('#facc15', '#ffffff')).toBe('#111827');
  });
});
