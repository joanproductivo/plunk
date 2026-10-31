import {describe, expect, it} from 'vitest';

import {segmentName} from '../segments';

describe('segmentName', () => {
  const segments = [
    {id: 'a', name: 'Customers'},
    {id: 'b', name: 'Free workshop'},
  ];

  it('is the name of the segment with that id', () => {
    expect(segmentName(segments, 'b')).toBe('Free workshop');
  });

  it('marks a segment that is gone as deleted', () => {
    expect(segmentName(segments, 'c')).toBe('Deleted segment');
  });

  it('is a placeholder while the segments load', () => {
    expect(segmentName(undefined, 'a')).toBe('…');
  });
});
