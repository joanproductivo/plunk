import {describe, expect, it} from 'vitest';

import {slugify} from '../index.js';

describe('slugify', () => {
  it('keeps lowercase ASCII words joined by hyphens, without accents', () => {
    expect(slugify('Café niño')).toBe('cafe-nino');
    expect(slugify('Logo_Final (2)')).toBe('logo-final-2');
  });

  it('trims separators, also those left by cutting to length', () => {
    expect(slugify('_logo_')).toBe('logo');
    expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  it('is empty when nothing readable is left', () => {
    expect(slugify('€€€')).toBe('');
    expect(slugify('日本')).toBe('');
  });

  it('drops letters it cannot spell in ASCII', () => {
    expect(slugify('Straße Ærø')).toBe('stra-e-r');
  });
});
