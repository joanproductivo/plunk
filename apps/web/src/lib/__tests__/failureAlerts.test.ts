import {describe, expect, it} from 'vitest';

import {describeFailure, parseRecipients, shortError} from '../failureAlerts';

describe('failure alerts', () => {
  it('says how often a source failed and since when', () => {
    const failure = {sourceKey: 'transactional', firstAt: '2026-10-26T10:42:00.000Z'};
    expect(describeFailure({...failure, count: 1}, 'en-GB')).toMatch(/^Failed 1 time since /);
    expect(describeFailure({...failure, count: 3}, 'en-GB')).toMatch(/^Failed 3 times since /);
  });

  it('says how often a condition was seen, for the reputation and domains', () => {
    const since = {count: 2, firstAt: '2026-10-26T10:42:00.000Z'};
    expect(describeFailure({...since, sourceKey: 'security:warning'}, 'en-GB')).toMatch(/^Seen 2 times since /);
    expect(describeFailure({...since, sourceKey: 'domain:d1'}, 'en-GB')).toMatch(/^Seen 2 times since /);
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
