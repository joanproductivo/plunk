import {describe, expect, it} from 'vitest';

import {describeFailure, parseRecipients, shortError} from '../failureAlerts';

describe('failure alerts', () => {
  it('says how often a source failed and since when', () => {
    expect(describeFailure({count: 1, firstAt: '2026-10-26T10:42:00.000Z'}, 'en-GB')).toMatch(/^Failed 1 time since /);
    expect(describeFailure({count: 3, firstAt: '2026-10-26T10:42:00.000Z'}, 'en-GB')).toMatch(/^Failed 3 times since /);
  });

  it('keeps an error to one short line', () => {
    expect(shortError('Email address\n  is not verified.')).toBe('Email address is not verified.');
    const long = shortError('x'.repeat(500));
    expect(long).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads addresses one per line or separated by commas, once each', () => {
    expect(parseRecipients(' Ops@Example.org\nboss@example.org, ops@example.org;\n\n')).toEqual([
      'ops@example.org',
      'boss@example.org',
    ]);
  });
});
