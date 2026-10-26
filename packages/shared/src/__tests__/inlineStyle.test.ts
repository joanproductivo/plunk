import {describe, expect, it} from 'vitest';

import {readPixels, withDeclaration} from '../template/index.js';

describe('withDeclaration', () => {
  it('sets a property after the others, dropping any earlier value of it', () => {
    expect(withDeclaration('margin: 0; color: inherit; font-weight: 600', 'color', '#ffffff')).toBe(
      'margin: 0; font-weight: 600; color: #ffffff',
    );
    expect(withDeclaration('COLOR: red', 'color', '#000000')).toBe('color: #000000');
    expect(withDeclaration(undefined, 'padding', '24px 0')).toBe('padding: 24px 0');
  });
});

describe('readPixels', () => {
  it.each([
    ['600', 600],
    ['0', 0],
    ['1e3', 0],
    ['12.5', 0],
    ['-4', 0],
    ['999999', 0],
    [undefined, 0],
  ])('reads %s as %i', (value, pixels) => {
    expect(readPixels(value)).toBe(pixels);
  });
});
