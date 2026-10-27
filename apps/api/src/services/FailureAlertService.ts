import {escapeHtml, FAILURE_ALERTS_OPEN_MAX, isFailureNotice} from '@plunk/shared';
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
  /**
   * `workflow:<id>`, `campaign:<id>`, `transactional` or `project` for failures; `security:warning`,
   * `security:critical`, `domain:<id>`, `sns:<what>` (the SES event pipeline) or `aws:alarm:<name>`
   * for conditions the project should hear about. Each kind is in SOURCE_KINDS.
   */
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
const REPUTATION_KEY = (projectId: string, level: ReputationLevel) =>
  `plunk-lite:alerts:reputation:${projectId}:${level}`;
// The same reputation conditions are recorded again after this long, however many events arrive
const REPUTATION_REPEAT_SECONDS = 86400;

type ReputationLevel = 'warning' | 'critical';

const SECURITY_PATH = '/settings?tab=security';

/** A kind of source: what an alert calls it and where the dashboard shows it */
interface SourceKind {
  name: {en: (label: string) => string; es: (label: string) => string};
  /** From what follows the kind in the key: an id, an alarm's name */
  path: (rest: string) => string;
}

/**
 * The kinds of source, by the leading parts of their keys: `campaign:<id>`, `aws:alarm:<name>`. A key
 * is read as the longest kind it starts with, so `security:critical` has its own name and
 * `security:warning` is a `security` one.
 */
const SOURCE_KINDS: Record<string, SourceKind> = {
  'workflow': {
    name: {en: label => `Workflow "${label}"`, es: label => `Workflow «${label}»`},
    path: id => `/workflows/${encodeURIComponent(id)}?tab=executions`,
  },
  'campaign': {
    name: {en: label => `Campaign "${label}"`, es: label => `Campaña «${label}»`},
    path: id => `/campaigns/${encodeURIComponent(id)}`,
  },
  'project': {name: {en: () => 'Project disabled', es: () => 'Proyecto desactivado'}, path: () => SECURITY_PATH},
  'security': {name: {en: label => label, es: () => 'Reputación de envío: aviso'}, path: () => SECURITY_PATH},
  'security:critical': {
    name: {en: label => label, es: () => 'Reputación de envío: crítico'},
    path: () => SECURITY_PATH,
  },
  'domain': {
    name: {en: label => `Domain "${label}"`, es: label => `Dominio «${label}»`},
    path: () => '/settings?tab=domains',
  },
  // The SES event pipeline: SNS delivers every bounce, complaint and delivery to the webhook
  'sns:unmatched': {name: {en: label => label, es: () => 'Eventos de SES sin email'}, path: () => SECURITY_PATH},
  'sns:subscription': {
    name: {en: label => label, es: () => 'Suscripción de eventos de SES eliminada'},
    path: () => SECURITY_PATH,
  },
  'sns:invalid': {name: {en: label => label, es: () => 'Eventos de SES ilegibles'}, path: () => SECURITY_PATH},
  // A CloudWatch alarm of the AWS account, by its name
  'aws:alarm': {
    name: {en: label => `AWS alarm "${label}"`, es: label => `Alarma de AWS «${label}»`},
    path: () => SECURITY_PATH,
  },
};

const TRANSACTIONAL: SourceKind = {
  name: {en: () => 'Transactional emails', es: () => 'Emails transaccionales'},
  path: () => '/activity',
};

/**
 * The kinds of source alerted on even while the project is disabled: its own suspension, and the
 * reputation and SES conditions that led to it or came after. The SES account keeps working, since
 * `disabled` is Plunk's own mark, and in a self-hosted installation it is the owner's account.
 */
const ALERTED_WHILE_DISABLED = ['project', 'security', 'sns', 'brake'];

function sourceKind(sourceKey: string): {kind: SourceKind; rest: string} {
  const parts = sourceKey.split(':');
  for (let length = parts.length; length > 0; length--) {
    const kind = SOURCE_KINDS[parts.slice(0, length).join(':')];
    if (kind) {
      return {kind, rest: parts.slice(length).join(':')};
    }
  }
  return {kind: TRANSACTIONAL, rest: ''};
}

const COPY = {
  en: {
    source: (sourceKey: string, label: string) => sourceKind(sourceKey).kind.name.en(label),
    subject: (project: string, source: string) => `[${project}] Failed: ${source}`,
    noticeSubject: (project: string, source: string) => `[${project}] Needs attention: ${source}`,
    times: (count: number, since: string) => `Failed ${count} ${count === 1 ? 'time' : 'times'} since ${since}.`,
    seen: (count: number, since: string) => `Seen ${count} ${count === 1 ? 'time' : 'times'} since ${since}.`,
    lastError: 'Last error',
    details: 'Details',
    contact: 'Last contact',
    review: 'Review it in Plunk',
    footer: 'You get at most one alert per source an hour. Change who gets these in Settings → Alerts.',
    test: 'This is a test alert: nothing has failed.',
    disabled: 'Nothing is sent from the project until it is reactivated, in Settings → Security.',
  },
  es: {
    source: (sourceKey: string, label: string) => sourceKind(sourceKey).kind.name.es(label),
    subject: (project: string, source: string) => `[${project}] Ha fallado: ${source}`,
    noticeSubject: (project: string, source: string) => `[${project}] Requiere atención: ${source}`,
    times: (count: number, since: string) => `Ha fallado ${count} ${count === 1 ? 'vez' : 'veces'} desde ${since}.`,
    seen: (count: number, since: string) => `Detectado ${count} ${count === 1 ? 'vez' : 'veces'} desde ${since}.`,
    lastError: 'Último error',
    details: 'Detalle',
    contact: 'Último contacto',
    review: 'Revisarlo en Plunk',
    footer: 'Recibes como mucho un aviso por origen cada hora. Elige quién los recibe en Settings → Alerts.',
    test: 'Este es un aviso de prueba: no ha fallado nada.',
    disabled: 'El proyecto no envía nada hasta que se reactive, en Settings → Security.',
  },
} as const;

/**
 * Failures a project should hear about (Plunk Lite), and conditions that make its emails fail: its
 * sending reputation past a threshold, a domain that stopped being verified. Each one is recorded
 * under its source, the dashboard shows the sources not reviewed since their last failure, and the
 * addresses in the project's alert settings get an email the first time a source fails and then at
 * most once an hour while it keeps failing.
 *
 * Recording and alerting never throw: they run on the path of a failure that is already being
 * handled, and must leave it as it was.
 */
export class FailureAlertService {
  /**
   * Records a failure under its source and alerts the project if it is the source's turn. True when
   * it was, so the alert is on its way; false when the source was alerted on within the hour, or
   * the failure could not be recorded. With `alert` off it is only recorded, for the banner.
   */
  public static async record(
    projectId: string,
    report: FailureReport,
    {alert = true}: {alert?: boolean} = {},
  ): Promise<boolean> {
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
      if (!alert) {
        return false;
      }

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
      return Boolean(claimed);
    } catch (recordError) {
      signale.warn(`[ALERTS] Could not record a failure of ${report.sourceKey} in project ${projectId}:`, recordError);
      return false;
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

  /**
   * A condition of the whole installation rather than of one project -- the SES event pipeline, an
   * alarm of the AWS account -- recorded in every project that can act on it, each alerting as
   * `record` does. Disabled projects are left out unless `includeDisabled`. Never throws.
   */
  public static async recordForAll(
    report: FailureReport,
    {includeDisabled = false, alert = true}: {includeDisabled?: boolean; alert?: boolean} = {},
  ): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: includeDisabled ? {} : {disabled: false},
        select: {id: true},
      });
      for (const project of projects) {
        await this.record(project.id, report, {alert});
      }
    } catch (lookupError) {
      signale.warn(`[ALERTS] Could not record ${report.sourceKey} in the projects:`, lookupError);
    }
  }

  /**
   * A condition that is over, in every project: its source is marked reviewed up to its last
   * failure, so the banner drops it until it is recorded again. Never throws.
   */
  public static async resolveForAll(sourceKey: string): Promise<void> {
    try {
      await prisma.$executeRaw`
        UPDATE "plunk_lite_failures" SET "reviewedAt" = "lastAt"
        WHERE "sourceKey" = ${sourceKey} AND ("reviewedAt" IS NULL OR "reviewedAt" < "lastAt")`;
    } catch (resolveError) {
      signale.warn(`[ALERTS] Could not resolve ${sourceKey} in the projects:`, resolveError);
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

  /**
   * Bounce or complaint rates past a threshold: warnings, or critical ones that did not disable the
   * project. All-time rates can stay past one for months while every bounce or complaint checks them
   * again, so once an alert about some conditions is sent they are not recorded again for a day,
   * unless a condition not among them comes up.
   */
  public static async recordReputation(projectId: string, level: ReputationLevel, conditions: string[]): Promise<void> {
    // Each condition without its numbers: a rate moving within the same threshold is no news
    const shapes = conditions.map(condition => condition.replace(/\d+(\.\d+)?/g, '#'));
    const key = REPUTATION_KEY(projectId, level);
    try {
      const alerted = (await redis.get(key))?.split('\n');
      if (alerted && shapes.every(shape => alerted.includes(shape))) {
        return;
      }
    } catch (redisError) {
      // Recorded anyway: an alert too many beats one missed
      signale.warn(`[ALERTS] Could not check the last reputation alert of project ${projectId}:`, redisError);
    }

    const alerting = await this.record(projectId, {
      sourceKey: `security:${level}`,
      label: level === 'critical' ? 'Sending reputation: critical' : 'Sending reputation: warning',
      error: conditions.join('; '),
    });
    // Only once an alert goes out: until then, the next bounce or complaint records them again, and
    // the first one past the hourly limit sends it
    if (alerting) {
      await redis.set(key, shapes.join('\n'), 'EX', REPUTATION_REPEAT_SECONDS).catch((redisError: unknown) => {
        signale.warn(`[ALERTS] Could not keep the last reputation alert of project ${projectId}:`, redisError);
      });
    }
  }

  /** A domain SES stopped verifying, so the project's emails from it fail */
  public static async recordDomainUnverified(
    projectId: string,
    domain: {id: string; domain: string},
    status: string,
  ): Promise<void> {
    await this.record(projectId, {
      sourceKey: `domain:${domain.id}`,
      label: domain.domain,
      error: `SES reports the domain as ${status}: emails from ${domain.domain} fail until its DNS records are back.`,
    });
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

  /**
   * Sends a sample alert to the saved addresses, from the saved sender, which must be on a verified
   * domain. Throws what SES says, so the dashboard can show it.
   */
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
   * disabled project only sends the alerts in ALERTED_WHILE_DISABLED, its suspension among them,
   * and never a test.
   *
   * Sent with `sendRawEmail` from the project's own domain, like a campaign's test send: Plunk's
   * platform emails (`sendPlatformEmail`) need PLUNK_API_KEY, which these installations do not set.
   * While the saved sender's domain is not verified, an alert goes from another verified domain of
   * the project (see `senderFor`); with none, and for a test, it throws.
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
    const alertedWhileDisabled = !test && ALERTED_WHILE_DISABLED.includes(failure.sourceKey.split(':')[0]!);
    if (!settings || !project || (project.disabled && !alertedWhileDisabled)) {
      return false;
    }

    const fromEmail = await this.senderFor(projectId, settings.fromEmail, {fallback: !test});
    if (!fromEmail) {
      throw new HttpException(
        403,
        test
          ? `The domain of ${settings.fromEmail} is not verified`
          : 'The project has no verified domain to send alerts from',
      );
    }

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
    const subject = test
      ? `[${project.name}] ${copy.test}`
      : isFailureNotice(failure.sourceKey)
        ? copy.noticeSubject(project.name, source)
        : copy.subject(project.name, source);
    const html = test ? `<p>${escapeHtml(copy.test)}</p>` : this.alertBody(copy, source, failure);

    // One email per address, so no one sees who else gets them
    const rejected: string[] = [];
    for (const recipient of settings.recipients) {
      try {
        await sendRawEmail({
          from: {name: settings.fromName || project.name, email: fromEmail},
          to: [recipient],
          content: {subject, html},
          // Out-of-office replies to an hourly alert would come back every hour
          headers: {'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All'},
          tracking: false,
          tags: {projectId, kind: 'alert'},
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

  /**
   * The address alerts go from: the saved one while its domain is verified for the project;
   * otherwise (the very failure being reported, perhaps) the same name on the oldest other verified
   * domain of it, unless `fallback` is off. Null when there is none.
   */
  private static async senderFor(
    projectId: string,
    fromEmail: string,
    {fallback}: {fallback: boolean},
  ): Promise<string | null> {
    const [name, domain] = fromEmail.split('@');
    if (!name || !domain) {
      return null;
    }
    const verified = await DomainService.getVerifiedDomains(projectId);
    if (verified.some(candidate => candidate.domain === domain)) {
      return fromEmail;
    }
    const [oldest] = verified.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return fallback && oldest ? `${name}@${oldest.domain}` : null;
  }

  private static alertBody(copy: (typeof COPY)[keyof typeof COPY], source: string, failure: FailureRow): string {
    const since = failure.firstAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const notice = isFailureNotice(failure.sourceKey);
    const lines = [
      `<p><strong>${escapeHtml(source)}</strong></p>`,
      `<p>${escapeHtml(notice ? copy.seen(failure.count, since) : copy.times(failure.count, since))}</p>`,
      `<p>${escapeHtml(notice ? copy.details : copy.lastError)}: ${escapeHtml(failure.lastError)}</p>`,
    ];
    if (failure.lastContactEmail) {
      lines.push(`<p>${escapeHtml(copy.contact)}: ${escapeHtml(failure.lastContactEmail)}</p>`);
    }
    if (failure.sourceKey === 'project') {
      lines.push(`<p>${escapeHtml(copy.disabled)}</p>`);
    }
    lines.push(
      `<p><a href="${escapeHtml(DASHBOARD_URI + this.reviewPath(failure.sourceKey))}">${escapeHtml(copy.review)}</a></p>`,
      `<p style="color:#737373;font-size:12px">${escapeHtml(copy.footer)}</p>`,
    );
    return lines.join('\n');
  }

  /** Where the dashboard shows a source's failures, as a path of the dashboard */
  private static reviewPath(sourceKey: string): string {
    const {kind, rest} = sourceKind(sourceKey);
    return kind.path(rest);
  }
}
