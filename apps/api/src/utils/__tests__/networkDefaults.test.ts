import net from 'node:net';

import {describe, expect, it} from 'vitest';

import {CONNECTION_ATTEMPT_TIMEOUT_MS} from '../networkDefaults.js';

describe('networkDefaults', () => {
  it('gives each address of a host 2 s to connect, not the 250 ms that failed healthy hosts', () => {
    expect(CONNECTION_ATTEMPT_TIMEOUT_MS).toBe(2_000);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2_000);
  });
});
