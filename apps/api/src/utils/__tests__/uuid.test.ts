import {describe, expect, it} from 'vitest';

import {uuidv5} from '../uuid';

describe('uuidv5', () => {
  it('matches the RFC 9562 test vector', () => {
    // RFC 9562, appendix A.4: the DNS namespace and "www.example.com"
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('gives the same id for the same name and different ids for different names', () => {
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidv5('a', namespace)).toBe(uuidv5('a', namespace));
    expect(uuidv5('a', namespace)).not.toBe(uuidv5('b', namespace));
  });
});
