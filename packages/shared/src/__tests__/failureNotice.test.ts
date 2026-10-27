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
    'project',
    'project:reactivated',
    'brake:campaign:abc',
    'brake:workflow:abc',
    'security:check',
    'sns:events',
    'sns:config',
  ])('reads %s as a condition that needs attention', sourceKey => {
    expect(isFailureNotice(sourceKey)).toBe(true);
  });

  it.each(['workflow:abc', 'campaign:abc', 'transactional', 'projects', 'snsx'])('reads %s as a failure', sourceKey => {
    expect(isFailureNotice(sourceKey)).toBe(false);
  });
});
