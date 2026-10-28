import type {AnalyticsTimeseriesPoint} from '@plunk/types';
import {describe, expect, it} from 'vitest';

import {audienceBalance, metric} from '../metrics';

const point = (counts: Partial<AnalyticsTimeseriesPoint>): AnalyticsTimeseriesPoint => ({
  bucket: '2026-10-24T00:00',
  sent: 0,
  tracked: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  ...counts,
});

/**
 * Opens and clicks are only recorded on emails sent with tracking, so their figures are
 * measured against those emails and have nothing to show when none were tracked.
 */
describe('analytics metrics', () => {
  it('measures opens and clicks against tracked emails', () => {
    const p = point({sent: 4, tracked: 2, opened: 1, clicked: 1});

    expect(metric('openRate').fromPoint(p)).toBe(50);
    expect(metric('clickRate').fromPoint(p)).toBe(50);
  });

  it('has no open or click rate for a bucket without tracked emails', () => {
    const p = point({sent: 4, tracked: 0});

    expect(metric('openRate').fromPoint(p)).toBeNull();
    expect(metric('clickRate').fromPoint(p)).toBeNull();
  });

  it('takes the volume of opens, clicks and click-to-open from tracked emails and the rest from emails sent', () => {
    const counts = {sent: 10, tracked: 4};

    expect(metric('openRate').volume(counts)).toBe(4);
    expect(metric('clickRate').volume(counts)).toBe(4);
    expect(metric('clickToOpenRate').volume(counts)).toBe(4);
    expect(metric('sent').volume(counts)).toBe(10);
    expect(metric('deliveryRate').volume(counts)).toBe(10);
    expect(metric('bounceRate').volume(counts)).toBe(10);
  });
});

/**
 * Plunk Lite: a bounce or complaint also unsubscribes the contact, so it is in both figures and
 * counts once in the sums
 */
describe('audienceBalance', () => {
  it('counts a contact who bounced, and so unsubscribed, once in the net', () => {
    // Two left: one opted out, one bounced and was unsubscribed by it
    const balance = audienceBalance({newContacts: 5, unsubscribed: 2, suppressed: 1, lost: 2});

    expect(balance).toEqual({net: 3, unsubscribedOnly: 1, inBoth: 1});
  });

  it('keeps the old arithmetic when no bounce unsubscribed anyone', () => {
    // A bounce of a contact who had already unsubscribed: nobody is in both
    const balance = audienceBalance({newContacts: 0, unsubscribed: 1, suppressed: 1, lost: 2});

    expect(balance).toEqual({net: -2, unsubscribedOnly: 1, inBoth: 0});
  });
});
