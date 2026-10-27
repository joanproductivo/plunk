import {CampaignStatus, Prisma} from '@plunk/db';
import signale from 'signale';

import {PLUNK_LITE_DISABLE_BOUNCE_PERCENT, PLUNK_LITE_DISABLE_COMPLAINT_PERCENT} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {HttpException} from '../exceptions/index.js';
import {utcTimestamp} from '../utils/database.js';

import {CampaignService} from './CampaignService.js';
import type {DeletedCounts} from './DeletedEmailCounts.js';
import {DeletedEmailCounts, RATE_COUNTS, RATED_EMAIL} from './DeletedEmailCounts.js';
import {FailureAlertService} from './FailureAlertService.js';
import {ProjectService} from './ProjectService.js';
import type {SecurityMetric} from './SecurityService.js';

/**
 * Plunk Lite: how bounce and complaint rates are counted, and when they are bad enough to disable
 * the project.
 *
 * Disabling a project stops everything it sends, transactional emails included, so it is the last
 * resort: a campaign or workflow that bounces is stopped on its own first (SourceBrakeService), and
 * the project only past higher rates than Plunk's critical ones -- still under the 10% bounce rate
 * and 0.5% complaint rate at which AWS pauses the whole account. Plunk's other criticals (all-time
 * rates, the ceilings for new projects) only alert.
 *
 * A project disabled for its reputation can be reactivated from the dashboard. For the next 7 days
 * only the emails it sends from then on count towards disabling it again, or the bounces that
 * disabled it would do so at once -- deleted ones included, which are counted by the hour.
 */

export interface RateData {
  total: number;
  bounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
}

/** Which emails a rate counts: a project's, optionally since a date and of one campaign or workflow */
export interface RateFilter {
  projectId: string;
  since?: Date;
  /**
   * What the deleted counts held for the hour of `since` when the window started, left out of it
   * (DeletedEmailCounts.sums): for a window that starts at a reactivation
   */
  deletedAtStart?: DeletedCounts;
  campaignId?: string;
  workflowId?: string;
}

/** What the rates of the last 7 days say about disabling the project */
export interface DisableVerdict extends Record<SecurityMetric, boolean> {
  sevenDay: RateData;
  /** Why, one line per metric past its threshold */
  violations: string[];
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

/** A grace period after a reactivation, as stored */
interface Grace {
  reactivatedAt: Date;
  deletedInHour: DeletedCounts;
}

/**
 * When the project was last reactivated, and what its deleted counts held for that hour then (a
 * Grace, as JSON), kept as long as its emails before then are in the 7 days
 */
const REACTIVATED_KEY = (projectId: string) => `plunk-lite:reactivated:${projectId}`;

/**
 * Past these, in the last 7 days, the project is disabled (with AUTO_PROJECT_DISABLE). The minimum of
 * emails is for bounces only: a handful of complaints is already a warning from the mailbox
 * providers, however few emails went out.
 */
const DISABLE_THRESHOLDS = {
  MIN_EMAILS_FOR_BOUNCES: 200,
  BOUNCE_PERCENT: PLUNK_LITE_DISABLE_BOUNCE_PERCENT,
  MIN_BOUNCES: 25,
  COMPLAINT_PERCENT: PLUNK_LITE_DISABLE_COMPLAINT_PERCENT,
  MIN_COMPLAINTS: 5,
} as const;

export class ReputationPolicy {
  /**
   * Emails given to SES, and how many of them bounced or were reported as spam, in one statement.
   *
   * Mail to the SES mailbox simulator is left out of both sides of every rate: it never leaves AWS,
   * which keeps it out of its own rates, and counting a deliberate `bounce@simulator.amazonses.com`
   * test would let a sender rehearsing their bounce handling warn or disable their own project.
   * Only emails SES was given count, as only those count for AWS: a campaign creates its rows well
   * ahead of the send, and counting the ones still queued would understate the rate exactly while a
   * large send is going out.
   *
   * A project's rates also count its deleted emails (DeletedEmailCounts), as AWS still does; the
   * rates of one campaign or workflow, for its brake, only count the emails it still has.
   */
  public static async rates({projectId, since, deletedAtStart, campaignId, workflowId}: RateFilter): Promise<RateData> {
    const projectWide = !campaignId && !workflowId;
    const [row] = await prisma.$queryRaw<{total: number; bounces: number; complaints: number}[]>`
      SELECT live."total" + gone."total" AS "total",
             live."bounces" + gone."bounces" AS "bounces",
             live."complaints" + gone."complaints" AS "complaints"
      FROM (
        SELECT ${RATE_COUNTS}
        FROM "emails" e
        ${workflowId ? Prisma.sql`JOIN "workflow_executions" we ON we."id" = e."workflowExecutionId"` : Prisma.empty}
        WHERE e."projectId" = ${projectId}
          AND ${RATED_EMAIL}
          ${since ? Prisma.sql`AND e."createdAt" >= ${utcTimestamp(since)}` : Prisma.empty}
          ${campaignId ? Prisma.sql`AND e."campaignId" = ${campaignId}` : Prisma.empty}
          ${workflowId ? Prisma.sql`AND we."workflowId" = ${workflowId}` : Prisma.empty}
      ) AS live("total", "bounces", "complaints"),
      ${projectWide ? DeletedEmailCounts.sums(projectId, since, deletedAtStart) : Prisma.sql`(SELECT 0, 0, 0)`} AS gone("total", "bounces", "complaints")`;

    const {total, bounces, complaints} = row ?? {total: 0, bounces: 0, complaints: 0};
    return {
      total,
      bounces,
      complaints,
      bounceRate: total > 0 ? (bounces / total) * 100 : 0,
      complaintRate: total > 0 ? (complaints / total) * 100 : 0,
    };
  }

  /**
   * Whether the bounce or the complaint rate of the last 7 days -- or since the project was
   * reactivated, if that is later -- is past disabling the project
   */
  public static async disableByMetric(projectId: string): Promise<DisableVerdict> {
    const grace = await this.grace(projectId);
    const weekAgo = new Date(Date.now() - SEVEN_DAYS_MS);
    const sinceReactivation = Boolean(grace && grace.reactivatedAt > weekAgo);
    const since = sinceReactivation ? grace!.reactivatedAt : weekAgo;
    const window = sinceReactivation ? 'Since reactivation,' : '7-day';
    // The emails deleted are counted by the hour, so the hour of the reactivation holds the bounces
    // deleted before it, which disabled the project: what it held then is left out
    const sevenDay = await this.rates({
      projectId,
      since,
      ...(sinceReactivation && {deletedAtStart: grace!.deletedInHour}),
    });
    const bounce =
      sevenDay.total >= DISABLE_THRESHOLDS.MIN_EMAILS_FOR_BOUNCES &&
      sevenDay.bounces >= DISABLE_THRESHOLDS.MIN_BOUNCES &&
      sevenDay.bounceRate >= DISABLE_THRESHOLDS.BOUNCE_PERCENT;
    const complaint =
      sevenDay.complaints >= DISABLE_THRESHOLDS.MIN_COMPLAINTS &&
      sevenDay.complaintRate >= DISABLE_THRESHOLDS.COMPLAINT_PERCENT;

    const violations: string[] = [];
    if (bounce) {
      violations.push(
        `${window} bounce rate (${sevenDay.bounceRate.toFixed(2)}%, ${sevenDay.bounces} of ${sevenDay.total} emails) reached ${DISABLE_THRESHOLDS.BOUNCE_PERCENT}%`,
      );
    }
    if (complaint) {
      violations.push(
        `${window} complaint rate (${sevenDay.complaintRate.toFixed(3)}%, ${sevenDay.complaints} of ${sevenDay.total} emails) reached ${DISABLE_THRESHOLDS.COMPLAINT_PERCENT}%`,
      );
    }
    return {bounce, complaint, sevenDay, violations};
  }

  /**
   * Reactivates a project disabled for its sending reputation, for an admin of it (`by`). Other
   * reasons still take a database change, on purpose. The grace period is stored first: if it
   * cannot be, the project stays disabled rather than being disabled again by its next bounce.
   *
   * The scheduled campaigns the disable cancelled, which never created an email, go back to drafts
   * to be scheduled again. Returns how many.
   */
  public static async reactivate(projectId: string, by: string): Promise<{draftedCampaigns: number}> {
    const project = await prisma.project.findUnique({
      where: {id: projectId},
      select: {id: true, secret: true, public: true, disabled: true, disabledReason: true},
    });
    if (!project?.disabled || project.disabledReason !== 'EMAIL_REPUTATION') {
      throw new HttpException(409, 'Only a project disabled for its sending reputation can be reactivated');
    }

    const reactivatedAt = new Date();
    const grace: Grace = {reactivatedAt, deletedInHour: await DeletedEmailCounts.inHour(projectId, reactivatedAt)};
    await redis.set(REACTIVATED_KEY(projectId), JSON.stringify(grace), 'EX', SEVEN_DAYS_MS / 1000);
    const reactivated = await prisma.project.updateMany({
      where: {id: projectId, disabled: true, disabledReason: 'EMAIL_REPUTATION'},
      data: {disabled: false, disabledReason: null},
    });
    if (reactivated.count === 0) {
      // Reactivated, or disabled for another reason, in between: this grace period is not owed
      await redis.del(REACTIVATED_KEY(projectId)).catch(() => undefined);
      throw new HttpException(409, 'Only a project disabled for its sending reputation can be reactivated');
    }
    await ProjectService.invalidate(project);

    let draftedCampaigns = 0;
    const cancelled = await prisma.campaign.findMany({
      where: {projectId, status: CampaignStatus.CANCELLED, emails: {none: {}}},
      select: {id: true},
    });
    for (const {id} of cancelled) {
      try {
        await CampaignService.cancel(projectId, id);
        draftedCampaigns++;
      } catch (error) {
        signale.warn(`[SECURITY] Could not return campaign ${id} of project ${projectId} to the drafts:`, error);
      }
    }

    signale.info(`[SECURITY] Project ${projectId} reactivated by ${by}`);
    await FailureAlertService.resolve('project', projectId);
    await FailureAlertService.record(projectId, {
      sourceKey: 'project:reactivated',
      label: 'Project reactivated',
      error: `Reactivated by ${by}. For 7 days only the emails sent from now on count towards disabling it again.${draftedCampaigns > 0 ? ` ${draftedCampaigns} scheduled ${draftedCampaigns === 1 ? 'campaign was' : 'campaigns were'} cancelled when it was disabled: ${draftedCampaigns === 1 ? 'it is a draft' : 'they are drafts'} again, to schedule again.` : ''}`,
    });
    return {draftedCampaigns};
  }

  /**
   * When the project was reactivated, within the last 7 days, and what its deleted counts held for
   * that hour then; undefined when Redis cannot say. Without those counts (a grace period stored
   * before they were, or one that cannot be read) the hour counts whole: the side that stops sending.
   */
  private static async grace(
    projectId: string,
  ): Promise<{reactivatedAt: Date; deletedInHour?: DeletedCounts} | undefined> {
    try {
      const value = await redis.get(REACTIVATED_KEY(projectId));
      if (!value) {
        return undefined;
      }
      let stored: unknown = value;
      try {
        stored = JSON.parse(value);
      } catch {
        // A bare date, as the grace period was first stored
      }
      const fields = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {at: stored};
      const date = new Date(String(fields.reactivatedAt ?? fields.at));
      if (Number.isNaN(date.getTime())) {
        return undefined;
      }
      const counts = fields.deletedInHour as Record<string, unknown> | undefined;
      const valid = (name: string) => Number.isInteger(counts?.[name]) && (counts![name] as number) >= 0;
      return {
        reactivatedAt: date,
        ...(valid('sent') &&
          valid('bounced') &&
          valid('complained') && {deletedInHour: counts as unknown as DeletedCounts}),
      };
    } catch (error) {
      // Counted as if there were no grace period: the side that stops sending
      signale.warn(`[SECURITY] Could not read when project ${projectId} was reactivated:`, error);
      return undefined;
    }
  }
}
