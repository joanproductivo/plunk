import {describe, expect, it} from 'vitest';

import {SUPPORTED_LANGUAGES} from '../i18n/index.js';
import en from '../i18n/locales/en.json' with {type: 'json'};

const keysOf = (value: unknown, prefix = ''): string[] =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1)];

/** A key missing in a language shows as the key itself, never as English: every locale has them all */
describe('translations', () => {
  it.each(SUPPORTED_LANGUAGES.map(language => language.code))('%s has every key English has', async code => {
    const {default: locale} = (await import(`../i18n/locales/${code}.json`, {with: {type: 'json'}})) as {
      default: unknown;
    };
    expect(keysOf(locale).sort()).toEqual(keysOf(en).sort());
  });
});
