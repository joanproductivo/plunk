import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {redis} from '../../database/redis';
import {FailureAlertService} from '../FailureAlertService';
import {emailQueue} from '../QueueService';
import {getAccountSendingEnabledQuick} from '../SESService';
import {
  accountSendingEnabled,
  holdSending,
  noteQuotaHeld,
  noteSent,
  pauseSending,
  refusalMeansPause,
  resumeSendingIfDue,
  SES_DAILY_QUOTA_WAIT_MS,
  SES_PAUSE_PROBE_MS,
} from '../SesSendGate';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  getAccountSendingEnabledQuick: vi.fn(async () => null),
}));

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

  it('without an answer from SES, takes 20 refusals in a minute for a pause only from two sender domains', async () => {
    const minute = Date.UTC(2030, 0, 1, 12, 0);
    for (let i = 0; i < 25; i++) {
      expect(await refusalMeansPause('una.example.com', 'Refused.', minute + i)).toBe(false);
    }

    const other = Date.UTC(2030, 0, 1, 13, 0);
    const answers = [];
    for (let i = 0; i < 20; i++) {
      answers.push(await refusalMeansPause(i % 2 ? 'una.example.com' : 'dieta.example.com', 'Refused.', other + i));
    }
    expect(answers.slice(0, 19)).not.toContain(true);
    expect(answers[19]).toBe(true);
  });

  it('after a probe, takes one refusal worded like the pause for the pause, from one domain', async () => {
    await pauseSending('Your account is on hold for ana@una.example.com.');
    expect(await resumeSendingIfDue(Date.now() + SES_PAUSE_PROBE_MS + 1000)).toBe(true);

    const minute = Date.UTC(2030, 0, 1, 14, 0);
    expect(await refusalMeansPause('una.example.com', 'Your account is on hold for c@una.example.com.', minute)).toBe(
      true,
    );

    // A refusal worded otherwise -- an email of its own, a domain of its own -- is not the pause
    const later = Date.UTC(2030, 0, 1, 15, 0);
    for (let i = 0; i < 10; i++) {
      expect(await refusalMeansPause('una.example.com', 'Message too long.', later + i)).toBe(false);
    }
  });

  it("takes SES's own answer, when it gives one, over what the refusals look like", async () => {
    const minute = Date.UTC(2030, 0, 1, 16, 0);
    vi.mocked(getAccountSendingEnabledQuick).mockResolvedValueOnce(false);
    expect(await refusalMeansPause('una.example.com', 'Refused.', minute)).toBe(true);

    // Two domains refusing at once, while SES says the account may send: not a pause
    const later = Date.UTC(2030, 0, 1, 17, 0);
    vi.mocked(getAccountSendingEnabledQuick).mockResolvedValueOnce(true);
    const answers = [];
    for (let i = 0; i < 25; i++) {
      answers.push(await refusalMeansPause(i % 2 ? 'una.example.com' : 'dieta.example.com', 'Refused.', later + i));
    }
    expect(answers).not.toContain(true);
    // ...asked once, the answer kept for 10 seconds
    expect(getAccountSendingEnabledQuick).toHaveBeenCalledTimes(2);
  });

  it('keeps a paused queue paused while SES says the account is still paused', async () => {
    await pauseSending('Sending paused for this account.');
    const due = Date.now() + SES_PAUSE_PROBE_MS + 1000;
    vi.mocked(getAccountSendingEnabledQuick).mockResolvedValueOnce(false);

    expect(await resumeSendingIfDue(due)).toBe(false);
    expect(await emailQueue.isPaused()).toBe(true);

    vi.mocked(getAccountSendingEnabledQuick).mockResolvedValueOnce(true);
    expect(await resumeSendingIfDue(due + 61_000)).toBe(true);
    expect(await emailQueue.isPaused()).toBe(false);
  });

  it('asks SES again once its answer is old: 10 seconds after a yes, a minute after a no', async () => {
    const at = Date.UTC(2030, 0, 1, 18, 0);
    vi.mocked(getAccountSendingEnabledQuick).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await accountSendingEnabled(at)).toBe(true);
    expect(await accountSendingEnabled(at + 9_000)).toBe(true);
    expect(await accountSendingEnabled(at + 11_000)).toBe(false);
    expect(await accountSendingEnabled(at + 60_000)).toBe(false);
    expect(getAccountSendingEnabledQuick).toHaveBeenCalledTimes(2);
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
