import {afterEach, describe, expect, it, vi} from 'vitest';

import {parsePositiveInt} from '../constants.js';

const KEY = 'EMAIL_RATE_LIMIT_PER_SECOND';

/** Plunk Lite: the worker's rate and concurrency never come out as NaN or 0 from a bad value */
describe('parsePositiveInt', () => {
  afterEach(() => {
    delete process.env[KEY];
    vi.restoreAllMocks();
  });

  it('is undefined, without a warning, when the variable is unset or empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parsePositiveInt(KEY)).toBeUndefined();
    process.env[KEY] = '';
    expect(parsePositiveInt(KEY)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a whole number above 0, around spaces', () => {
    process.env[KEY] = '14';
    expect(parsePositiveInt(KEY)).toBe(14);
    process.env[KEY] = ' 12 ';
    expect(parsePositiveInt(KEY)).toBe(12);
  });

  it('ignores anything else, with a warning, without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const raw of ['0', '-3', '1.5', 'abc']) {
      process.env[KEY] = raw;
      expect(parsePositiveInt(KEY)).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
