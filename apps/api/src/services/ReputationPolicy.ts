import {Prisma} from '@plunk/db';

import {PLUNK_LITE_DISABLE_BOUNCE_PERCENT, PLUNK_LITE_DISABLE_COMPLAINT_PERCENT} from '../app/constants.js';
import {prisma} from '../database/prisma.js';

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

/** Past these, in the last 7 days, the project is disabled (with AUTO_PROJECT_DISABLE) */
export const DISABLE_THRESHOLDS = {
  MIN_EMAILS: 200,
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
   */
  public static async rates({projectId, since, campaignId, workflowId}: RateFilter): Promise<RateData> {
    const [row] = await prisma.$queryRaw<{total: number; bounces: number; complaints: number}[]>`
      SELECT count(*)::int AS "total",
             (count(*) FILTER (WHERE e."bouncedAt" IS NOT NULL))::int AS "bounces",
             (count(*) FILTER (WHERE e."complainedAt" IS NOT NULL))::int AS "complaints"
      FROM "emails" e
      ${workflowId ? Prisma.sql`JOIN "workflow_executions" we ON we."id" = e."workflowExecutionId"` : Prisma.empty}
      WHERE e."projectId" = ${projectId}
        AND e."simulated" = false
        AND e."sentAt" IS NOT NULL
        ${since ? Prisma.sql`AND e."createdAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')` : Prisma.empty}
        ${campaignId ? Prisma.sql`AND e."campaignId" = ${campaignId}` : Prisma.empty}
        ${workflowId ? Prisma.sql`AND we."workflowId" = ${workflowId}` : Prisma.empty}`;

    const {total, bounces, complaints} = row ?? {total: 0, bounces: 0, complaints: 0};
    return {
      total,
      bounces,
      complaints,
      bounceRate: total > 0 ? (bounces / total) * 100 : 0,
      complaintRate: total > 0 ? (complaints / total) * 100 : 0,
    };
  }

  /** Whether the bounce or the complaint rate of the last 7 days is past disabling the project */
  public static async disableByMetric(projectId: string): Promise<DisableVerdict> {
    const sevenDay = await this.rates({projectId, since: new Date(Date.now() - SEVEN_DAYS_MS)});
    const enough = sevenDay.total >= DISABLE_THRESHOLDS.MIN_EMAILS;
    const bounce =
      enough &&
      sevenDay.bounces >= DISABLE_THRESHOLDS.MIN_BOUNCES &&
      sevenDay.bounceRate >= DISABLE_THRESHOLDS.BOUNCE_PERCENT;
    const complaint =
      enough &&
      sevenDay.complaints >= DISABLE_THRESHOLDS.MIN_COMPLAINTS &&
      sevenDay.complaintRate >= DISABLE_THRESHOLDS.COMPLAINT_PERCENT;

    const violations: string[] = [];
    if (bounce) {
      violations.push(
        `7-day bounce rate (${sevenDay.bounceRate.toFixed(2)}%, ${sevenDay.bounces} of ${sevenDay.total} emails) reached ${DISABLE_THRESHOLDS.BOUNCE_PERCENT}%`,
      );
    }
    if (complaint) {
      violations.push(
        `7-day complaint rate (${sevenDay.complaintRate.toFixed(3)}%, ${sevenDay.complaints} of ${sevenDay.total} emails) reached ${DISABLE_THRESHOLDS.COMPLAINT_PERCENT}%`,
      );
    }
    return {bounce, complaint, sevenDay, violations};
  }
}
