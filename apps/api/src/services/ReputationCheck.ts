import type {SecurityCheckJobData} from '@plunk/types';
import signale from 'signale';

import {redis, redisReady} from '../database/redis.js';
import {TimedOut, withTimeout} from '../utils/withTimeout.js';

import {FailureAlertService} from './FailureAlertService.js';
import {QueueService} from './QueueService.js';
import type {SecurityMetric} from './SecurityService.js';
import {SecurityService} from './SecurityService.js';
import {SourceBrakeService} from './SourceBrakeService.js';

/**
 * Plunk Lite: the reputation check that follows a new bounce or complaint, run once for a burst of
 * them in the `plunk-lite-checks` queue (see QueueService.queueSecurityCheck). It judges first the
 * campaigns and workflows the events came from (SourceBrakeService), then the project.
 *
 * Only the job of the first event of a burst is kept, so what every event brought is collected in a
 * Redis sorted set of the project -- `trigger:<metric>`, and its source as `campaign:<id>` or
 * `workflow:<id>` -- each scored by a counter that only goes up. The check reads it all and, once it
 * has judged it, removes what it read up to the highest score: an item noted again meanwhile has a
 * higher one and stays, and a check that fails, or a worker that dies, leaves it all for the next
 * one. When the set cannot be read, every campaign of the project still sending is judged.
 */
const PENDING_KEY = (projectId: string) => `plunk-lite:security:pending-z:${projectId}`;
const PENDING_SEQ_KEY = (projectId: string) => `plunk-lite:security:pending-seq:${projectId}`;
// The plain set the items were kept in before, merged into the sorted one by the next check. A
// day after this is deployed none is left (PENDING_SECONDS), and this can go.
const LEGACY_PENDING_KEY = (projectId: string) => `plunk-lite:security:pending:${projectId}`;
// A check runs within seconds; this only bounds a set no check ever takes
const PENDING_SECONDS = 86400;

// Adds the items with the next score, at once, so none is added with a score a check already read
const NOTE_PENDING = `
local seq = redis.call('INCR', KEYS[2])
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], seq, ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return seq`;

// Merges the legacy set in, then reads the sorted set with its scores
const READ_PENDING = `
local legacy = redis.call('SPOP', KEYS[3], 1000)
if #legacy > 0 then
  local seq = redis.call('INCR', KEYS[2])
  for _, item in ipairs(legacy) do
    redis.call('ZADD', KEYS[1], 'NX', seq, item)
  end
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')`;
const METRICS: SecurityMetric[] = ['bounce', 'complaint'];
/**
 * How long queueing the check may take. BullMQ waits for Redis for as long as it is down, and the
 * webhook that queues it must still answer SNS.
 */
const QUEUE_TIMEOUT_MS = 3000;
/**
 * How long the check run in its place may take, for the same reason. With Redis down it skips what
 * it reads and writes there; what still waits on it (cancelling the project's jobs once it is
 * disabled) comes after the database writes that stop the sending. A connection cut without a
 * reset still reads as connected, and only this bounds it.
 */
const RUN_TIMEOUT_MS = 10_000;

export class ReputationCheck {
  /**
   * Has the project's reputation checked after a new bounce or complaint of one of its emails. When
   * the check cannot be queued, within a few seconds, it runs here and now, for ten seconds at most;
   * if that fails too, the project is told its reputation is not being watched. Never throws: the
   * event is already recorded.
   */
  public static async afterEvent(
    email: {projectId: string; campaignId: string | null; workflowExecutionId: string | null},
    trigger: SecurityMetric,
  ): Promise<void> {
    const source = await SourceBrakeService.sourceOf(email).catch((error: unknown) => {
      signale.warn(`[SECURITY] Could not tell which workflow an email of project ${email.projectId} came from:`, error);
      return undefined;
    });
    const data: SecurityCheckJobData = {projectId: email.projectId, trigger, ...(source && {source})};
    // Bounded like the queueing: with Redis down it waits for it, and the job carries its own event
    await withTimeout(
      this.notePending(email.projectId, [`trigger:${trigger}`, ...(source ? [source] : [])]),
      QUEUE_TIMEOUT_MS,
    ).catch((error: unknown) => {
      signale.warn(
        `[SECURITY] Could not note the ${trigger} for the reputation check of project ${email.projectId}:`,
        error,
      );
    });

    try {
      // A job that is queued after all once Redis is back only checks the project again
      await withTimeout(QueueService.queueSecurityCheck(data), QUEUE_TIMEOUT_MS);
    } catch (queueError) {
      signale.warn(
        `[SECURITY] Could not queue the reputation check of project ${email.projectId}, running it now:`,
        queueError,
      );
      try {
        await withTimeout(this.run(data, {reserve: true}), RUN_TIMEOUT_MS);
      } catch (checkError) {
        signale.error(`[SECURITY] Reputation check of project ${email.projectId} failed:`, checkError);
        await this.exhausted(data, checkError);
      }
    }
  }

  /**
   * The check itself, as the job runs it: the sources, then the project, which is checked even when
   * judging a source failed. Throws when either could not tell, so the job tries again.
   *
   * With Redis down, the job throws too, to be tried again rather than judge the project without its
   * grace period. The check run in place of the job (`reserve`) cannot wait: it judges without what
   * Redis holds -- the source of its own event and every campaign still sending, no grace period,
   * which can only disable again -- and writes nothing there.
   */
  public static async run(data: SecurityCheckJobData, {reserve = false}: {reserve?: boolean} = {}): Promise<void> {
    const withoutRedis = !redisReady();
    if (withoutRedis && !reserve) {
      throw new Error('Redis is not connected');
    }
    if (withoutRedis) {
      signale.warn(`[SECURITY] Redis is down, checking project ${data.projectId} without what it holds`);
    }
    const pending = withoutRedis ? undefined : await this.readPending(data.projectId);
    const taken = pending?.items ?? [];
    const sources = taken.filter(item => !item.startsWith('trigger:'));
    if (data.source) {
      sources.push(data.source);
    }
    if (!pending) {
      sources.push(...(await SourceBrakeService.sendingCampaigns(data.projectId)));
    }

    let brakeError: unknown;
    try {
      await SourceBrakeService.brake(data.projectId, sources);
    } catch (error) {
      brakeError = error;
    }

    const triggers = METRICS.filter(metric => metric === data.trigger || taken.includes(`trigger:${metric}`));
    await SecurityService.checkAndEnforceSecurityLimits(data.projectId, triggers, {withoutRedis});
    if (brakeError) {
      throw brakeError;
    }
    if (pending) {
      await this.clearPending(data.projectId, pending.upTo);
    }
  }

  /**
   * A check that ran out of attempts, or that could neither be queued nor run in time: the
   * project's reputation is not being watched, or may not be. Never throws.
   */
  public static async exhausted(data: SecurityCheckJobData, error: unknown): Promise<void> {
    await FailureAlertService.record(data.projectId, {
      sourceKey: 'security:check',
      label: 'Sending reputation check',
      error:
        error instanceof TimedOut
          ? `The check of the bounce and complaint rates after a ${data.trigger} did not finish within ${RUN_TIMEOUT_MS / 1000} seconds, and may complete later. Until it does, the project would not be stopped if they were too high.`
          : `The bounce and complaint rates could not be checked after a ${data.trigger}, so the project would not be stopped if they were too high: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  private static async notePending(projectId: string, items: string[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    try {
      await redis.eval(NOTE_PENDING, 2, PENDING_KEY(projectId), PENDING_SEQ_KEY(projectId), PENDING_SECONDS, ...items);
    } catch (error) {
      // The job still carries its own event
      signale.warn(
        `[SECURITY] Could not note ${items.join(', ')} for the reputation check of project ${projectId}:`,
        error,
      );
    }
  }

  /**
   * What the events since the last check brought, and the highest score among them; undefined when
   * Redis cannot say
   */
  private static async readPending(projectId: string): Promise<{items: string[]; upTo: number} | undefined> {
    try {
      const read = (await redis.eval(
        READ_PENDING,
        3,
        PENDING_KEY(projectId),
        PENDING_SEQ_KEY(projectId),
        LEGACY_PENDING_KEY(projectId),
        PENDING_SECONDS,
      )) as string[];
      const items: string[] = [];
      let upTo = 0;
      for (let i = 0; i < read.length; i += 2) {
        items.push(read[i]!);
        upTo = Math.max(upTo, Number(read[i + 1]));
      }
      return {items, upTo};
    } catch (error) {
      signale.warn(`[SECURITY] Could not read what the reputation check of project ${projectId} is for:`, error);
      return undefined;
    }
  }

  /**
   * Removes what a check judged, up to the highest score it read. If it cannot, the next check
   * judges it again, which changes nothing.
   */
  private static async clearPending(projectId: string, upTo: number): Promise<void> {
    if (upTo === 0) {
      return;
    }
    try {
      await redis.zremrangebyscore(PENDING_KEY(projectId), '-inf', upTo);
    } catch (error) {
      signale.warn(`[SECURITY] Could not clear what the reputation check of project ${projectId} judged:`, error);
    }
  }
}
