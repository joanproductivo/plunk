import type {SecurityCheckJobData} from '@plunk/types';
import signale from 'signale';

import {redis} from '../database/redis.js';

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
 * Redis set of the project -- `trigger:<metric>`, and its source as `campaign:<id>` or
 * `workflow:<id>` -- and the check takes it all. A check that fails gives it back for its next
 * attempt. When the set cannot be read, every campaign of the project still sending is judged.
 */
const PENDING_KEY = (projectId: string) => `plunk-lite:security:pending:${projectId}`;
// A check runs within seconds; this only bounds a set no check ever takes
const PENDING_SECONDS = 86400;
const METRICS: SecurityMetric[] = ['bounce', 'complaint'];

export class ReputationCheck {
  /**
   * Has the project's reputation checked after a new bounce or complaint of one of its emails. When
   * the check cannot be queued it runs here and now. Never throws: the event is already recorded.
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
    await this.notePending(email.projectId, [`trigger:${trigger}`, ...(source ? [source] : [])]);

    try {
      await QueueService.queueSecurityCheck(data);
    } catch (queueError) {
      signale.warn(
        `[SECURITY] Could not queue the reputation check of project ${email.projectId}, running it now:`,
        queueError,
      );
      try {
        await this.run(data);
      } catch (checkError) {
        signale.error(`[SECURITY] Reputation check of project ${email.projectId} failed:`, checkError);
      }
    }
  }

  /**
   * The check itself, as the job runs it: the sources, then the project, which is checked even when
   * judging a source failed. Throws when either could not tell, so the job tries again.
   */
  public static async run(data: SecurityCheckJobData): Promise<void> {
    const pending = await this.takePending(data.projectId);
    const taken = pending ?? [];
    try {
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
      await SecurityService.checkAndEnforceSecurityLimits(data.projectId, triggers);
      if (brakeError) {
        throw brakeError;
      }
    } catch (error) {
      await this.notePending(data.projectId, taken);
      throw error;
    }
  }

  /** A check that ran out of attempts: the project's reputation is not being watched */
  public static async exhausted(data: SecurityCheckJobData, error: unknown): Promise<void> {
    await FailureAlertService.record(data.projectId, {
      sourceKey: 'security:check',
      label: 'Sending reputation check',
      error: `The bounce and complaint rates could not be checked after a ${data.trigger}, so the project would not be stopped if they were too high: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  private static async notePending(projectId: string, items: string[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    try {
      await redis
        .multi()
        .sadd(PENDING_KEY(projectId), ...items)
        .expire(PENDING_KEY(projectId), PENDING_SECONDS)
        .exec();
    } catch (error) {
      // The job still carries its own event
      signale.warn(
        `[SECURITY] Could not note ${items.join(', ')} for the reputation check of project ${projectId}:`,
        error,
      );
    }
  }

  /** What the events since the last check brought; undefined when Redis cannot say */
  private static async takePending(projectId: string): Promise<string[] | undefined> {
    const items: string[] = [];
    try {
      for (let batch = await redis.spop(PENDING_KEY(projectId), 100); batch.length > 0; ) {
        items.push(...batch);
        batch = await redis.spop(PENDING_KEY(projectId), 100);
      }
    } catch (error) {
      signale.warn(`[SECURITY] Could not read what the reputation check of project ${projectId} is for:`, error);
      return undefined;
    }
    return items;
  }
}
