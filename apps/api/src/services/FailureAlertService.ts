import {escapeHtml, FAILURE_ALERTS_OPEN_MAX} from '@plunk/shared';
import type {AlertSettings, FailureAlert} from '@plunk/types';
import signale from 'signale';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {HttpException} from '../exceptions/index.js';

import {DomainService} from './DomainService.js';
import {sendRawEmail} from './SESService.js';
import {failureSourceFor} from './failureSources.js';

/** One failure, as the place it happened knows it */
export interface FailureReport {
  /** `workflow:<id>`, `campaign:<id>`, `transactional` or `project` */
  sourceKey: string;
  /** What the dashboard and the alert call the source, e.g. the workflow's name */
  label: string;
  error: string;
  contactEmail?: string | null;
}

interface FailureRow {
  id: string;
  sourceKey: string;
  label: string;
  count: number;
  lastError: string;
  lastContactEmail: string | null;
  firstAt: Date;
  lastAt: Date;
}

const ERROR_MAX = 1000;
// However many sources fail, a project sends at most this many alerts an hour
const ALERTS_PER_HOUR = 10;
// Outside `Keys`, which is Plunk's: these keys are Plunk Lite's own
const TEST_KEY = (projectId: string) => `plunk-lite:alerts:test:${projectId}`;
const SENT_KEY = (projectId: string) => `plunk-lite:alerts:sent:${projectId}`;

const COPY = {
  en: {
    source: (sourceKey: string, label: string) =>
      sourceKey.startsWith('workflow:')
        ? `Workflow "${label}"`
        : sourceKey.startsWith('campaign:')
          ? `Campaign "${label}"`
          : sourceKey === 'project'
            ? 'The project'
            : 'Transactional emails',
    subject: (project: string, source: string) => `[${project}] Failed: ${source}`,
    times: (count: number, since: string) => `Failed ${count} ${count === 1 ? 'time' : 'times'} since ${since}.`,
    lastError: 'Last error',
    contact: 'Last contact',
    review: 'Review it in Plunk',
    footer: 'You get at most one alert per source an hour. Change who gets these in Settings → Alerts.',
    test: 'This is a test alert: nothing has failed.',
  },
  es: {
    source: (sourceKey: string, label: string) =>
      sourceKey.startsWith('workflow:')
        ? `Workflow «${label}»`
        : sourceKey.startsWith('campaign:')
          ? `Campaña «${label}»`
          : sourceKey === 'project'
            ? 'El proyecto'
            : 'Emails transaccionales',
    subject: (project: string, source: string) => `[${project}] Ha fallado: ${source}`,
    times: (count: number, since: string) => `Ha fallado ${count} ${count === 1 ? 'vez' : 'veces'} desde ${since}.`,
    lastError: 'Último error',
    contact: 'Último contacto',
    review: 'Revisarlo en Plunk',
    footer: 'Recibes como mucho un aviso por origen cada hora. Elige quién los recibe en Settings → Alerts.',
    test: 'Este es un aviso de prueba: no ha fallado nada.',
  },
} as const;

/**
 * Failures a project should hear about (Plunk Lite). Each one is recorded under its source, the
 * dashboard shows the sources not reviewed since their last failure, and the addresses in the
 * project's alert settings get an email the first time a source fails and then at most once an
 * hour while it keeps failing.
 *
 * Recording and alerting never throw: they run on the path of a failure that is already being
 * handled, and must leave it as it was.
 */
export class FailureAlertService {
  /** Records a failure under its source and alerts the project if it is the source's turn. */
  public static async record(projectId: string, report: FailureReport): Promise<void> {
    try {
      const error = report.error.slice(0, ERROR_MAX);
      // A source reviewed since its last failure opens again: its count starts over and it gets
      // an alert again. Times are the database's, in UTC, like the rest of the row.
      const [row] = await prisma.$queryRaw<FailureRow[]>`
        INSERT INTO "plunk_lite_failures" ("projectId", "sourceKey", "label", "lastError", "lastContactEmail", "firstAt", "lastAt")
        VALUES (${projectId}, ${report.sourceKey}, ${report.label}, ${error}, ${report.contactEmail ?? null},
                now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
        ON CONFLICT ("projectId", "sourceKey") DO UPDATE SET
          "count" = CASE WHEN "plunk_lite_failures"."reviewedAt" >= "plunk_lite_failures"."lastAt" THEN 1
                         ELSE "plunk_lite_failures"."count" + 1 END,
          "firstAt" = CASE WHEN "plunk_lite_failures"."reviewedAt" >= "plunk_lite_failures"."lastAt" THEN now() AT TIME ZONE 'UTC'
                           ELSE "plunk_lite_failures"."firstAt" END,
          "notifiedAt" = CASE WHEN "plunk_lite_failures"."reviewedAt" >= "plunk_lite_failures"."lastAt" THEN NULL
                              ELSE "plunk_lite_failures"."notifiedAt" END,
          -- Never back: a failure whose statement started before the last one still comes after it
          "lastAt" = GREATEST(now() AT TIME ZONE 'UTC', "plunk_lite_failures"."lastAt" + interval '1 millisecond'),
          "label" = EXCLUDED."label",
          "lastError" = EXCLUDED."lastError",
          "lastContactEmail" = EXCLUDED."lastContactEmail"
        RETURNING "id", "sourceKey", "label", "count", "lastError", "lastContactEmail", "firstAt", "lastAt"`;

      // One alert per source an hour: of failures arriving together, the one that moves
      // `notifiedAt` sends it.
      const [claimed] = await prisma.$queryRaw<{notifiedAt: Date}[]>`
        UPDATE "plunk_lite_failures" SET "notifiedAt" = now() AT TIME ZONE 'UTC'
        WHERE "id" = ${row!.id}
          AND ("notifiedAt" IS NULL OR "notifiedAt" < (now() AT TIME ZONE 'UTC') - interval '1 hour')
        RETURNING "notifiedAt"`;

      if (claimed) {
        // Not awaited: the alert waits on SES, and the failure path it started from should not.
        void this.alertOrRelease(projectId, row!, claimed.notifiedAt);
      }
    } catch (recordError) {
      signale.warn(`[ALERTS] Could not record a failure of ${report.sourceKey} in project ${projectId}:`, recordError);
    }
  }

  /**
   * Sends the alert a failure claimed. With no one to tell (no addresses, a disabled project) the
   * claim is given back, so addresses set right after a failure hear about the next one. A send
   * that fails keeps it: SES is not asked again for an hour.
   */
  private static async alertOrRelease(projectId: string, failure: FailureRow, claimedAt: Date): Promise<void> {
    try {
      if (!(await this.sendAlert(projectId, failure))) {
        await prisma.$executeRaw`
          UPDATE "plunk_lite_failures" SET "notifiedAt" = NULL
          WHERE "id" = ${failure.id} AND "notifiedAt" = (${claimedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
      }
    } catch (alertError) {
      signale.warn(
        `[ALERTS] Could not alert project ${projectId} about ${failure.sourceKey}:`,
        alertError instanceof Error ? alertError.message : alertError,
      );
    }
  }

  /** An email SES did not take, under the workflow, campaign or API call that sent it */
  public static async recordEmail(
    email: {
      projectId: string;
      campaignId: string | null;
      campaign: {name: string} | null;
      workflowExecutionId: string | null;
      contact: {email: string};
    },
    error: string,
  ): Promise<void> {
    try {
      const workflow = email.workflowExecutionId
        ? (
            await prisma.workflowExecution.findUnique({
              where: {id: email.workflowExecutionId},
              select: {workflow: {select: {id: true, name: true}}},
            })
          )?.workflow
        : null;
      await this.record(email.projectId, {
        ...failureSourceFor({...email, workflow}),
        error,
        contactEmail: email.contact.email,
      });
    } catch (lookupError) {
      signale.warn(`[ALERTS] Could not record a failed email of project ${email.projectId}:`, lookupError);
    }
  }

  /** A campaign batch job that ran out of attempts */
  public static async recordCampaignJob(campaignId: string, error: string): Promise<void> {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: {id: campaignId},
        select: {projectId: true, name: true},
      });
      if (campaign) {
        await this.record(campaign.projectId, {sourceKey: `campaign:${campaignId}`, label: campaign.name, error});
      }
    } catch (lookupError) {
      signale.warn(`[ALERTS] Could not record the failed batch of campaign ${campaignId}:`, lookupError);
    }
  }

  /**
   * A workflow job that ran out of attempts. An execution that failed in a step was recorded
   * there; this catches the ones that failed before a step could run (a missing step, the
   * database), which leave the execution as it was.
   */
  public static async recordWorkflowJob(executionId: string, error: string): Promise<void> {
    try {
      const execution = await prisma.workflowExecution.findUnique({
        where: {id: executionId},
        select: {
          status: true,
          workflowId: true,
          workflow: {select: {name: true, projectId: true}},
          contact: {select: {email: true}},
        },
      });
      // A failed execution was recorded by its step; a finished or cancelled one is not failing
      if (execution && (execution.status === 'RUNNING' || execution.status === 'WAITING')) {
        await this.record(execution.workflow.projectId, {
          sourceKey: `workflow:${execution.workflowId}`,
          label: execution.workflow.name,
          error,
          contactEmail: execution.contact.email,
        });
      }
    } catch (lookupError) {
      signale.warn(`[ALERTS] Could not record the failed job of execution ${executionId}:`, lookupError);
    }
  }

  /** The sources with failures since they were last reviewed, latest first */
  public static async listOpen(projectId: string): Promise<FailureAlert[]> {
    const rows = await prisma.$queryRaw<FailureRow[]>`
      SELECT "id", "sourceKey", "label", "count", "lastError", "lastContactEmail", "firstAt", "lastAt"
      FROM "plunk_lite_failures"
      WHERE "projectId" = ${projectId} AND ("reviewedAt" IS NULL OR "reviewedAt" < "lastAt")
      ORDER BY "lastAt" DESC
      LIMIT ${FAILURE_ALERTS_OPEN_MAX}`;
    return rows.map(row => ({
      ...row,
      firstAt: row.firstAt.toISOString(),
      lastAt: row.lastAt.toISOString(),
      reviewPath: this.reviewPath(row.sourceKey),
    }));
  }

  /**
   * Marks reviewed what the dashboard showed: each source up to the failure that was seen, so one
   * that failed again since stays open. Returns how many were closed.
   */
  public static async review(projectId: string, seen: {id: string; lastAt: string}[]): Promise<number> {
    let closed = 0;
    for (const {id, lastAt} of seen) {
      closed += await prisma.$executeRaw`
        UPDATE "plunk_lite_failures" SET "reviewedAt" = "lastAt"
        WHERE "projectId" = ${projectId} AND "id" = ${id}
          AND "lastAt" = (${lastAt}::timestamptz AT TIME ZONE 'UTC')`;
    }
    return closed;
  }

  /** Where the project's alerts go; null when it has none */
  public static async getSettings(projectId: string): Promise<AlertSettings | null> {
    const row = await prisma.plunkLiteAlertSettings.findUnique({where: {projectId}});
    return row ? {recipients: row.recipients, fromEmail: row.fromEmail, fromName: row.fromName} : null;
  }

  /**
   * Replaces where the project's alerts go, already parsed (trimmed, lowercased). No addresses turn
   * the emails off. The sender must be on a domain of the project that is verified.
   */
  public static async saveSettings(
    projectId: string,
    settings: {recipients: string[]; fromEmail?: string; fromName?: string},
  ): Promise<AlertSettings | null> {
    const recipients = [...new Set(settings.recipients)];
    if (recipients.length === 0) {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      return null;
    }
    if (!settings.fromEmail) {
      throw new HttpException(400, 'Choose the address the alerts are sent from');
    }

    await DomainService.verifyEmailDomain(settings.fromEmail, projectId);

    const data = {recipients, fromEmail: settings.fromEmail, fromName: settings.fromName || null};
    await prisma.plunkLiteAlertSettings.upsert({where: {projectId}, create: {projectId, ...data}, update: data});
    return data;
  }

  /** Sends a sample alert to the saved addresses. Throws what SES says, so the dashboard can show it. */
  public static async sendTest(projectId: string): Promise<void> {
    if (!(await this.getSettings(projectId))) {
      throw new HttpException(400, 'Add at least one address first');
    }
    if (!(await redis.set(TEST_KEY(projectId), '1', 'EX', 60, 'NX'))) {
      throw new HttpException(429, 'Wait a minute before sending another test alert');
    }

    const now = new Date();
    const sent = await this.sendAlert(
      projectId,
      {
        id: '',
        sourceKey: 'test',
        label: 'Test',
        count: 1,
        lastError: '',
        lastContactEmail: null,
        firstAt: now,
        lastAt: now,
      },
      {test: true},
    );
    if (!sent) {
      throw new HttpException(400, 'A disabled project cannot send alerts');
    }
  }

  /**
   * Emails the project's alert addresses about a source; false when there is no one to tell. A
   * disabled project sends nothing: its account must not be used to report its own suspension.
   *
   * Sent with `sendRawEmail` from the project's own domain, like a campaign's test send: Plunk's
   * platform emails (`sendPlatformEmail`) need PLUNK_API_KEY, which these installations do not set.
   * Each address gets its own email, so a rejected one (an SES sandbox) does not stop the others;
   * what SES said for each rejected one is thrown together.
   */
  private static async sendAlert(
    projectId: string,
    failure: FailureRow,
    {test = false}: {test?: boolean} = {},
  ): Promise<boolean> {
    const [settings, project] = await Promise.all([
      this.getSettings(projectId),
      prisma.project.findUnique({where: {id: projectId}, select: {name: true, disabled: true, language: true}}),
    ]);
    if (!settings || !project || project.disabled) {
      return false;
    }

    await DomainService.verifyEmailDomain(settings.fromEmail, projectId);

    const sent = await redis.incr(SENT_KEY(projectId));
    if (sent === 1) {
      await redis.expire(SENT_KEY(projectId), 3600);
    }
    if (sent > ALERTS_PER_HOUR) {
      if (test) {
        throw new HttpException(429, 'This project has sent its alerts for this hour');
      }
      signale.warn(`[ALERTS] Project ${projectId} has sent ${ALERTS_PER_HOUR} alerts this hour, skipping one`);
      return true;
    }

    const copy = project.language.toLowerCase().startsWith('es') ? COPY.es : COPY.en;
    const source = copy.source(failure.sourceKey, failure.label);
    const subject = test ? `[${project.name}] ${copy.test}` : copy.subject(project.name, source);
    const html = test ? `<p>${escapeHtml(copy.test)}</p>` : this.alertBody(copy, source, failure);

    // One email per address, so no one sees who else gets them
    const rejected: string[] = [];
    for (const recipient of settings.recipients) {
      try {
        await sendRawEmail({
          from: {name: settings.fromName || project.name, email: settings.fromEmail},
          to: [recipient],
          content: {subject, html},
          // Out-of-office replies to an hourly alert would come back every hour
          headers: {'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All'},
          tracking: false,
        });
      } catch (error) {
        rejected.push(`${recipient}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rejected.length > 0) {
      throw new Error(rejected.join('; '));
    }
    return true;
  }

  private static alertBody(copy: (typeof COPY)[keyof typeof COPY], source: string, failure: FailureRow): string {
    const since = failure.firstAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const lines = [
      `<p><strong>${escapeHtml(source)}</strong></p>`,
      `<p>${escapeHtml(copy.times(failure.count, since))}</p>`,
      `<p>${escapeHtml(copy.lastError)}: ${escapeHtml(failure.lastError)}</p>`,
    ];
    if (failure.lastContactEmail) {
      lines.push(`<p>${escapeHtml(copy.contact)}: ${escapeHtml(failure.lastContactEmail)}</p>`);
    }
    lines.push(
      `<p><a href="${escapeHtml(DASHBOARD_URI + this.reviewPath(failure.sourceKey))}">${escapeHtml(copy.review)}</a></p>`,
      `<p style="color:#737373;font-size:12px">${escapeHtml(copy.footer)}</p>`,
    );
    return lines.join('\n');
  }

  /** Where the dashboard shows a source's failures, as a path of the dashboard */
  private static reviewPath(sourceKey: string): string {
    const [kind, id] = sourceKey.split(':');
    switch (kind) {
      case 'workflow':
        return `/workflows/${encodeURIComponent(id ?? '')}?tab=executions`;
      case 'campaign':
        return `/campaigns/${encodeURIComponent(id ?? '')}`;
      case 'project':
        return '/settings';
      default:
        return '/activity';
    }
  }
}
