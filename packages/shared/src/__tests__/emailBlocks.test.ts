import {describe, expect, it} from 'vitest';

import {readSpacerHeight, SPACER_DEFAULT_HEIGHT, spacerStyle} from '../template/index.js';

describe('readSpacerHeight', () => {
  it('reads back the style a spacer is saved with', () => {
    expect(readSpacerHeight(spacerStyle(48))).toBe(48);
  });

  it('reads the style as Chromium saves it', () => {
    expect(
      readSpacerHeight(
        'border-width: medium; border-style: none; border-color: currentcolor; border-image: none; margin: 0px; height: 64px;',
      ),
    ).toBe(64);
  });

  it('keeps a hand-written height within 1 to 200 px, rounded', () => {
    expect(readSpacerHeight('height: 100px')).toBe(100);
    expect(readSpacerHeight('height: 999px')).toBe(200);
    expect(readSpacerHeight('height: 0px')).toBe(1);
    expect(readSpacerHeight('HEIGHT: 24.6PX')).toBe(25);
  });

  it('falls back to the default height for anything else', () => {
    expect(readSpacerHeight(undefined)).toBe(SPACER_DEFAULT_HEIGHT);
    expect(readSpacerHeight('margin: 0px')).toBe(SPACER_DEFAULT_HEIGHT);
    expect(readSpacerHeight('height: 3em')).toBe(SPACER_DEFAULT_HEIGHT);
    expect(readSpacerHeight('height: -5px')).toBe(SPACER_DEFAULT_HEIGHT);
    expect(readSpacerHeight('line-height: 48px')).toBe(SPACER_DEFAULT_HEIGHT);
  });
});
