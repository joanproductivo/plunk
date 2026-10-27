import {afterEach, describe, expect, it, vi} from 'vitest';

import {parsePercent} from '../constants.js';

const KEY = 'PLUNK_LITE_DISABLE_COMPLAINT_PERCENT';

describe('parsePercent', () => {
  afterEach(() => {
    delete process.env[KEY];
    vi.restoreAllMocks();
  });

  it('uses the default when the variable is unset', () => {
    expect(parsePercent(KEY, '0.4')).toBe(0.4);
  });

  it('reads a decimal point or a decimal comma', () => {
    process.env[KEY] = '0.3';
    expect(parsePercent(KEY, '0.4')).toBe(0.3);
    process.env[KEY] = ' 0,3 ';
    expect(parsePercent(KEY, '0.4')).toBe(0.3);
  });

  it('falls back to the default, without throwing, for a value that is not a percentage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const raw of ['abc', '0', '100', '-1']) {
      process.env[KEY] = raw;
      expect(parsePercent(KEY, '0.4')).toBe(0.4);
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
