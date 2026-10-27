import {describe, expect, it} from 'vitest';

import {isFailureNotice} from '../schemas/index.js';

describe('isFailureNotice', () => {
  it.each([
    'security:warning',
    'security:critical',
    'domain:abc',
    'sns:unmatched',
    'sns:subscription',
    'aws:alarm:ses-rebotes-alto',
    'aws:alarm-subscription',
    'project',
    'project:reactivated',
    'brake:campaign:abc',
    'brake:workflow:abc',
    'security:check',
    'sns:events',
    'sns:config',
    'ses:paused',
    'ses:daily-quota',
    'redis:memory',
  ])('reads %s as a condition that needs attention', sourceKey => {
    expect(isFailureNotice(sourceKey)).toBe(true);
  });

  it.each(['workflow:abc', 'campaign:abc', 'transactional', 'projects', 'snsx', 'sesx', 'redisx'])(
    'reads %s as a failure',
    sourceKey => {
      expect(isFailureNotice(sourceKey)).toBe(false);
    },
  );
});
