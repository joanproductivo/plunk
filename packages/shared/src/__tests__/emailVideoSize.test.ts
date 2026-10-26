import {describe, expect, it} from 'vitest';

import {emailProseCss, readVideoSize, toEmailBrand, videoImageStyle, videoMaxWidth} from '../template/index.js';

// A video's poster style as the editor saved it before sizes
const SAVED_BEFORE_SIZES = 'display: block; width: 100%; height: auto; margin: 0px; border: 0px; border-radius: 12px;';

describe('video sizes', () => {
  it('reads each size back from the style it writes', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(readVideoSize(videoImageStyle(size))).toBe(size);
    }
  });

  it('writes small and medium capped for an email without a brand width, and large as wide as the text', () => {
    expect(videoImageStyle('small')).toBe(
      'display: block; width: 50%; max-width: 300px; height: auto; margin: 0px auto; border: 0px; border-radius: 12px;',
    );
    expect(videoImageStyle('medium')).toContain('width: 75%; max-width: 450px;');
    expect(videoImageStyle('large')).toBe(
      'display: block; width: 100%; height: auto; margin: 0px auto; border: 0px; border-radius: 12px;',
    );
  });

  it('reads videos saved before sizes as large, even with the prose styles inlined on them', () => {
    expect(readVideoSize(SAVED_BEFORE_SIZES)).toBe('large');
    // As sending inlines `.prose img`: its max-width is never taken for a size
    expect(readVideoSize(`margin-top: 1.7142857em; max-width: 100%; ${SAVED_BEFORE_SIZES}`)).toBe('large');
  });

  it.each([
    ['width: 50%', 'small'],
    ['width: 60%', 'small'],
    ['width: 70%', 'medium'],
    ['width: 90%', 'large'],
    ['width: 320px; max-width: 320px', 'large'],
    ['', 'large'],
    [null, 'large'],
  ] as const)('reads %s as %s', (style, size) => {
    expect(readVideoSize(style)).toBe(size);
  });

  it("caps each size at its share of the email's text width", () => {
    const framed = toEmailBrand({backgroundColor: '#f3f4f6', contentWidth: 600});
    expect([videoMaxWidth('small', framed), videoMaxWidth('medium', framed), videoMaxWidth('large', framed)]).toEqual([
      276, 414, 552,
    ]);
    expect(videoMaxWidth('large')).toBe(600);
  });

  it("keeps videos within the email's text width in the prose styles", () => {
    expect(emailProseCss()).toContain('.prose .email-video img {\n  max-width: 600px;\n}');
    expect(emailProseCss(toEmailBrand({backgroundColor: '#f3f4f6', contentWidth: 800}))).toContain(
      '.prose .email-video img {\n  max-width: 752px;\n}',
    );
  });
});
