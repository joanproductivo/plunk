import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {redis} from '../../database/redis';
import {FailureAlertService} from '../FailureAlertService';
import {emailQueue} from '../QueueService';
import {
  holdSending,
  manyRejections,
  noteQuotaHeld,
  noteSent,
  pauseSending,
  resumeSendingIfDue,
  SES_DAILY_QUOTA_WAIT_MS,
  SES_PAUSE_PROBE_MS,
} from '../SesSendGate';

/** Plunk Lite: how the email queue waits out what SES says about the whole account, on a real Redis */
describe('SesSendGate', () => {
  const limiter = emailQueue.keys.limiter!;
  const keys = [limiter, 'plunk-lite:ses:paused', 'plunk-lite:ses:probing', 'plunk-lite:ses:quota-held'];

  beforeEach(async () => {
    await redis.del(...keys);
    await emailQueue.resume();
  });

  afterEach(async () => {
    await redis.del(...keys);
    await emailQueue.resume();
  });

  it('only lengthens the hold, so the sending rate never cuts the daily quota short', async () => {
    await holdSending(SES_DAILY_QUOTA_WAIT_MS);
    await holdSending(1000);

    expect(await redis.pttl(limiter)).toBeGreaterThan(SES_DAILY_QUOTA_WAIT_MS - 5000);
  });

  it('resumes a paused queue once the pause is 30 minutes old, and not before', async () => {
    await pauseSending('Sending paused for this account.');
    expect(await emailQueue.isPaused()).toBe(true);

    expect(await resumeSendingIfDue(Date.now() + 60_000)).toBe(false);
    expect(await emailQueue.isPaused()).toBe(true);

    expect(await resumeSendingIfDue(Date.now() + SES_PAUSE_PROBE_MS + 1000)).toBe(true);
    expect(await emailQueue.isPaused()).toBe(false);
    expect(await redis.get('plunk-lite:ses:paused')).toBeNull();
  });

  it('keeps the first pause, so later refusals do not put the probe off', async () => {
    await pauseSending('first');
    const first = await redis.get('plunk-lite:ses:paused');
    await pauseSending('second');

    expect(await redis.get('plunk-lite:ses:paused')).toBe(first);
  });

  it('resumes a queue paused by hand, without a key, on the next probe', async () => {
    await emailQueue.pause();

    expect(await resumeSendingIfDue()).toBe(true);
    expect(await emailQueue.isPaused()).toBe(false);
  });

  it('takes 20 refusals in a minute for a pause only when they come from two sender domains', async () => {
    const minute = Date.UTC(2030, 0, 1, 12, 0);
    for (let i = 0; i < 25; i++) {
      expect(await manyRejections('una.example.com', 'Refused.', minute + i)).toBe(false);
    }

    const other = Date.UTC(2030, 0, 1, 13, 0);
    const answers = [];
    for (let i = 0; i < 20; i++) {
      answers.push(await manyRejections(i % 2 ? 'una.example.com' : 'dieta.example.com', 'Refused.', other + i));
    }
    expect(answers.slice(0, 19)).not.toContain(true);
    expect(answers[19]).toBe(true);
  });

  it('after a probe, takes a few refusals worded like the pause for the pause, from one domain', async () => {
    await pauseSending('Your account is on hold for ana@una.example.com.');
    expect(await resumeSendingIfDue(Date.now() + SES_PAUSE_PROBE_MS + 1000)).toBe(true);

    const minute = Date.UTC(2030, 0, 1, 14, 0);
    const answers = [];
    for (let i = 0; i < 5; i++) {
      answers.push(
        await manyRejections('una.example.com', `Your account is on hold for c${i}@una.example.com.`, minute + i),
      );
    }
    expect(answers).toEqual([false, false, false, false, true]);

    // A refusal worded otherwise -- an email of its own, a domain of its own -- is not the pause
    const later = Date.UTC(2030, 0, 1, 15, 0);
    for (let i = 0; i < 10; i++) {
      expect(await manyRejections('una.example.com', 'Message too long.', later + i)).toBe(false);
    }
  });

  it('resolves the pause and the quota alerts with the first email out, once', async () => {
    const resolve = vi.spyOn(FailureAlertService, 'resolve').mockResolvedValue(undefined);
    await pauseSending('Sending paused for this account.');
    await resumeSendingIfDue(Date.now() + SES_PAUSE_PROBE_MS + 1000);
    await noteQuotaHeld();

    await noteSent();
    await noteSent();

    expect(resolve.mock.calls.map(call => call[0])).toEqual(['ses:paused', 'ses:daily-quota']);
    // After the probe, the refusals that paused it no longer count as the pause
    expect(await redis.get('plunk-lite:ses:probing')).toBeNull();
  });

  it("lets a pause's mark expire, so one left by a failed pause cannot shorten a later wait for long", async () => {
    await pauseSending('Sending paused for this account.');

    expect(await redis.pttl('plunk-lite:ses:paused')).toBeGreaterThan(SES_PAUSE_PROBE_MS);
    expect(await redis.pttl('plunk-lite:ses:paused')).toBeLessThanOrEqual(2 * SES_PAUSE_PROBE_MS);
  });
});
