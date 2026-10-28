import signale from 'signale';

import {errorMessage, redis} from '../database/redis.js';

import {FailureAlertService} from './FailureAlertService.js';
import {emailQueue} from './QueueService.js';
import {getAccountSendingEnabledQuick} from './SESService.js';

/**
 * Plunk Lite: how the email queue waits out what SES says about the whole account. A rate or a
 * daily quota reached holds the queue back for a while (BullMQ's limiter); a paused account pauses
 * the queue, and the recovery sweep tries again every 30 minutes. Emails held back this way go back
 * to the queue without spending an attempt.
 *
 * Whether the account is paused is asked of SES (GetAccountSendingEnabled) when the IAM policy
 * allows it; without an answer, it is told from what the refusals look like.
 */

const PAUSED_KEY = 'plunk-lite:ses:paused';
/** What paused sending, kept from the probe's resume until an email goes out */
const PROBING_KEY = 'plunk-lite:ses:probing';
/** Set while the daily quota holds the queue back, until an email goes out */
const QUOTA_HELD_KEY = 'plunk-lite:ses:quota-held';

/** How long after a pause the sweep resumes the queue to see if SES sends again */
export const SES_PAUSE_PROBE_MS = 30 * 60_000;
/** How long the queue waits when the daily quota is used up, before trying again */
export const SES_DAILY_QUOTA_WAIT_MS = 15 * 60_000;
/** How long SES's sending rate holds the queue back */
export const SES_RATE_WAIT_MS = 1000;

/** How long the marks of a pause, a probe or a quota hold outlive their cause at most */
const PAUSE_KEY_TTL_MS = 2 * SES_PAUSE_PROBE_MS;
const AWAITING_SEND_TTL_MS = 48 * 60 * 60_000;

/** Refusals within a minute, from at least two sender domains, that mean the account is paused */
const REJECTIONS_FOR_PAUSE = 20;
const REJECTION_DOMAINS_FOR_PAUSE = 2;
/** How long an answer of GetAccountSendingEnabled is kept: a "may send" shortly, as a pause may follow */
const SENDING_ENABLED_TTL_MS = 10_000;
const SENDING_PAUSED_TTL_MS = 60_000;

/** The last question to SES: when it was asked, its answer, and the answer once it came */
let sendingEnabled: {at: number; answer: Promise<boolean | null>; enabled?: boolean | null} | undefined;

// Hold the limiter for `ms` -- only lengthening it, so a second's wait for the sending rate never
// cuts short the quarter of an hour of a used-up daily quota. Same value as BullMQ's rateLimit.
const EXTEND_LIMITER = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
end
return ttl`;

// Delete the pause only if it is still the one that was read
const DELETE_IF_UNCHANGED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** Hold the whole email queue back for `ms` (BullMQ moves held jobs back without spending an attempt) */
export async function holdSending(ms: number): Promise<void> {
  await redis.eval(EXTEND_LIMITER, 1, emailQueue.keys.limiter!, ms, Number.MAX_SAFE_INTEGER);
}

/**
 * Pause the email queue for an SES account pause. The first pause's time is kept; its mark expires
 * on its own, so one left by a pause that failed cannot cut a later pause's wait short for long.
 */
export async function pauseSending(reason: string): Promise<void> {
  // The key first: if pausing the queue then fails, the sweep only "resumes" a running queue
  await redis.set(PAUSED_KEY, JSON.stringify({reason, at: Date.now()}), 'PX', PAUSE_KEY_TTL_MS, 'NX');
  await emailQueue.pause();
}

/** The daily quota holds the queue back: the first email out afterwards resolves its alert */
export async function noteQuotaHeld(): Promise<void> {
  await redis.set(QUOTA_HELD_KEY, '1', 'PX', AWAITING_SEND_TTL_MS);
}

/**
 * The sweep's probe: resume a paused email queue once the pause is 30 minutes old. Also a pause made
 * by hand (QueueService.pauseAll, or this key deleted): to stop sending for good, disable the
 * project instead. If SES is still paused, the first sends pause it again, without spending
 * attempts. Returns whether it resumed.
 */
export async function resumeSendingIfDue(now = Date.now()): Promise<boolean> {
  if (!(await emailQueue.isPaused())) {
    return false;
  }
  const raw = await redis.get(PAUSED_KEY);
  if (raw) {
    const {at, reason} = JSON.parse(raw) as {at: number; reason: string};
    if (now - at < SES_PAUSE_PROBE_MS) {
      return false;
    }
    // SES says it is still paused: no probe, and so no refusals, until it says otherwise
    if ((await accountSendingEnabled(now)) === false) {
      return false;
    }
    // Before resuming, so a refusal that pauses again right after leaves a pause of its own
    await redis.eval(DELETE_IF_UNCHANGED, 1, PAUSED_KEY, raw);
    await redis.set(PROBING_KEY, reason, 'PX', AWAITING_SEND_TTL_MS);
  }
  await emailQueue.resume();
  signale.warn('[SES] Resuming the email queue after a pause, to see if SES sends again');
  return true;
}

/**
 * An email went out: a pause probed or a daily quota waited out is over, and its alert resolved.
 * Never throws, since it runs after the send has been recorded.
 */
export async function noteSent(): Promise<void> {
  try {
    const results = await redis.multi().del(PROBING_KEY).del(QUOTA_HELD_KEY).exec();
    if (Number(results?.[0]?.[1] ?? 0) > 0) {
      await FailureAlertService.resolve('ses:paused');
    }
    if (Number(results?.[1]?.[1] ?? 0) > 0) {
      await FailureAlertService.resolve('ses:daily-quota');
    }
  } catch (error) {
    signale.warn(`[SES] Could not note an email sent after a pause or a quota: ${errorMessage(error)}`);
  }
}

/**
 * Whether SES lets the account send, asked at most every 10 seconds (every minute once it says no,
 * or gives no answer). Null without an answer.
 */
export function accountSendingEnabled(now = Date.now()): Promise<boolean | null> {
  if (sendingEnabled) {
    const ttl = sendingEnabled.enabled === true ? SENDING_ENABLED_TTL_MS : SENDING_PAUSED_TTL_MS;
    // A question still on its way (at most 2 seconds) is shared rather than asked again; a clock
    // that went back makes the answer stale
    const age = now - sendingEnabled.at;
    if (sendingEnabled.enabled === undefined || (age >= 0 && age < ttl)) {
      return sendingEnabled.answer;
    }
  }
  const question: NonNullable<typeof sendingEnabled> = {at: now, answer: getAccountSendingEnabledQuick()};
  void question.answer.then(enabled => {
    question.enabled = enabled;
  });
  sendingEnabled = question;
  return question.answer;
}

/**
 * Whether a refusal SES gave an email for itself (`rejected`) is in fact the whole account paused,
 * in words this code does not know: SES's own answer when it gives one, otherwise the refusals' look
 * (manyRejections).
 */
export async function refusalMeansPause(fromDomain: string, message: string, now = Date.now()): Promise<boolean> {
  const enabled = await accountSendingEnabled(now);
  if (enabled !== null) {
    return !enabled;
  }
  return manyRejections(fromDomain, message, now);
}

/** A refusal's words without the addresses in them, to tell whether two refusals say the same */
function wording(message: string): string {
  return message.replace(/\S+@\S+/g, '@').trim();
}

/**
 * Count a refusal of an email from `fromDomain`, and say whether it looks like a paused account,
 * in words this code does not know. True once a minute holds 20 refusals from at least two sender
 * domains -- a paused account refuses every sender, while a domain that is not verified, or a bad
 * address, refuses only its own -- or, while a probe has resumed sending and nothing has gone out
 * yet, a refusal worded like the one that paused it. Best effort: with Redis out it says false.
 */
async function manyRejections(fromDomain: string, message: string, now = Date.now()): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  const countKey = `plunk-lite:ses:rejected:${minute}`;
  const domainsKey = `plunk-lite:ses:rejected-domains:${minute}`;
  try {
    const results = await redis
      .multi()
      .incr(countKey)
      .expire(countKey, 120)
      .sadd(domainsKey, fromDomain.toLowerCase())
      .expire(domainsKey, 120)
      .scard(domainsKey)
      .get(PROBING_KEY)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const domains = Number(results?.[4]?.[1] ?? 0);
    const probing = results?.[5]?.[1];
    if (typeof probing === 'string' && wording(probing) === wording(message)) {
      return true;
    }
    return count >= REJECTIONS_FOR_PAUSE && domains >= REJECTION_DOMAINS_FOR_PAUSE;
  } catch (error) {
    signale.warn(`[SES] Could not count a refusal: ${errorMessage(error)}`);
    return false;
  }
}
