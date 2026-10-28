import type {Prisma} from '@plunk/db';
import {EmailStatus} from '@plunk/db';
import {isMailboxSimulatorAddress} from '@plunk/shared';
import type {SubscriptionChangeReason} from '@plunk/types';
import signale from 'signale';
import {z} from 'zod';

import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {SES_EVENT_TRANSACTION, utcTimestamp} from '../utils/database.js';
import {UUID_PATTERN} from '../utils/uuid.js';

import {AwsAlarmService} from './AwsAlarmService.js';
import {CampaignService} from './CampaignService.js';
import {recipientAddress} from './EmailHeaderService.js';
import {FailureAlertService} from './FailureAlertService.js';
import {QueueService} from './QueueService.js';
import type {SesMessageTags} from './SESService.js';
import {SES_TAG, verifyConfigurationSets} from './SESService.js';
import {SuppressionService} from './SuppressionService.js';

/**
 * Plunk Lite: reading what SNS delivers to the SES webhook, matching each event with the email it is
 * about, and the trouble with it that no single email shows -- an event with no email, a message
 * that cannot be read, a run of rejected deliveries, events that stopped arriving, a configuration
 * set that does not publish them.
 */

/** The SES notifications the webhook handles; anything else is acknowledged and left alone */
const SES_EVENT_TYPES = ['Bounce', 'Complaint', 'Delivery', 'Open', 'Click', 'Reject', 'Received'] as const;
export type SesEventType = (typeof SES_EVENT_TYPES)[number];

/**
 * What every handled notification must carry. Only the message id is required: the other fields
 * are read when they are there and ignored when they are not the expected shape, so an odd field
 * cannot lose a bounce.
 */
const sesMessageSchema = z
  .object({
    mail: z
      .object({
        messageId: z.string().min(1),
        timestamp: z.string().optional().catch(undefined),
        destination: z.array(z.string()).optional().catch(undefined),
        source: z.string().optional().catch(undefined),
        tags: z.record(z.unknown()).optional().catch(undefined),
      })
      .passthrough(),
  })
  .passthrough();

export type SesMail = z.infer<typeof sesMessageSchema>['mail'];

export type SesNotification =
  | {kind: 'event'; eventType: SesEventType; mail: SesMail}
  // A notification of a type the webhook does not handle, such as SES's own test message
  | {kind: 'other'; type: unknown}
  | {kind: 'invalid'; reason: string};

/** The `Message` of an SNS notification, parsed; undefined when it is not JSON */
export function parseSnsMessage(message: unknown) {
  if (typeof message !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}

/**
 * What an SES notification is. Event publishing names its type `eventType`; identity notifications
 * and inbound mail name it `notificationType`.
 */
export function readSesNotification(body: unknown): SesNotification {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const type = fields.eventType ?? fields.notificationType;
  if (!SES_EVENT_TYPES.includes(type as SesEventType)) {
    return {kind: 'other', type};
  }

  const parsed = sesMessageSchema.safeParse(body);
  if (!parsed.success) {
    return {kind: 'invalid', reason: `${String(type)} notification without a message id`};
  }
  return {kind: 'event', eventType: type as SesEventType, mail: parsed.data.mail};
}

/** What SES publishes, as plain text, to a topic it is given as an event destination */
const SES_TOPIC_TEST = /^Successfully validated SNS topic/i;
// How much of a message that is not JSON the log shows
const NOT_JSON_SHOWN = 200;

/**
 * A notification whose message is not JSON, from one of the installation's topics. SES's own test
 * of a new event destination and anything on the alarms' topic are only logged; anything else is
 * reported as unreadable. True when it was not.
 */
export async function readNotJson(message: unknown, topicArn: unknown): Promise<boolean> {
  const text = String(message).slice(0, NOT_JSON_SHOWN);
  if (SES_TOPIC_TEST.test(text)) {
    signale.info(`[WEBHOOK] SES tested its topic: ${text}`);
    return true;
  }
  if (AwsAlarmService.isAlarmsTopic(topicArn)) {
    signale.warn(`[WEBHOOK] Ignoring a message of the alarms' topic that is not JSON: ${text}`);
    return true;
  }
  signale.warn(`[WEBHOOK] SNS message that is not JSON, from ${String(topicArn)}: ${text}`);
  await reportUnreadable('the message is not JSON');
  return false;
}

/**
 * A notification from this installation's own topic, with a valid signature, that cannot be read.
 * Delivering it again would not change it, so it is acknowledged; every project hears about it,
 * since nothing says which one it was for.
 */
export async function reportUnreadable(reason: string): Promise<void> {
  signale.error(`[WEBHOOK] SES notification dropped, it cannot be read: ${reason}`);
  await FailureAlertService.recordForAll({
    sourceKey: 'sns:invalid',
    label: 'Unreadable SES events',
    error: `A signed SES notification from this installation's topic could not be read (${reason}), so the bounce, complaint or delivery it reported was not recorded.`,
  });
}

/**
 * This endpoint's subscription to one of the installation's topics was removed: no SES event will
 * arrive from it again, and nothing else would show it, so every project hears about it. The
 * alarms' topic only takes the alarms off the dashboard (AwsAlarmService).
 */
export async function reportSubscriptionRemoved(topic: string): Promise<void> {
  if (AwsAlarmService.isAlarmsTopic(topic)) {
    await AwsAlarmService.reportSubscriptionRemoved(topic);
    return;
  }
  signale.error(`[WEBHOOK] SNS subscription to ${topic} was removed`);
  await FailureAlertService.recordForAll({
    sourceKey: 'sns:subscription',
    label: 'SES events subscription removed',
    error: `This server was unsubscribed from ${topic}: the events it published (bounces, complaints, deliveries) no longer arrive. Subscribe the webhook to it again.`,
  });
}

/**
 * How long after SES accepted an email an event for it may still find no row. The send path
 * stamps the messageId right after SES answers and retries the stamp for about four minutes if
 * the database is down, and the recovery sweep records it after that; until then, a 503 has SNS
 * deliver the event again instead of losing it.
 */
const UNMATCHED_EVENT_RETRY_MS = 30 * 60 * 1000;

const SES_KINDS: SesMessageTags['kind'][] = ['email', 'test', 'alert'];

/**
 * The tags Plunk sent the email with (see SES_TAG), each only when it has the expected shape: the
 * ids any UUID (a campaign's emails have version 5 ones), the kind one of the known ones.
 */
function sesTags(mail: SesMail): Partial<SesMessageTags> {
  const tag = (name: string) => {
    const values = mail.tags?.[name];
    const value: unknown = Array.isArray(values) ? values[0] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const id = (name: string) => {
    const value = tag(name);
    return value && UUID_PATTERN.test(value) ? value : undefined;
  };
  const kind = tag(SES_TAG.kind) as SesMessageTags['kind'] | undefined;
  return {
    emailId: id(SES_TAG.emailId),
    projectId: id(SES_TAG.projectId),
    kind: kind && SES_KINDS.includes(kind) ? kind : undefined,
  };
}

/** An address as SES writes it, bare or as `Name <address>`: lowercased, without the name */
function bareAddress(address: string): string {
  return (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase();
}

/**
 * The address SES was given for the email; `fallback` when the event does not say (an old
 * notification). Plunk gives SES one address per email.
 */
export function sentAddress(mail: SesMail, fallback: string): string {
  return bareAddress(mail.destination?.[0] ?? fallback);
}

/**
 * The addresses a bounce or complaint is about, lowercased. SES lists them in
 * `bouncedRecipients` / `complainedRecipients`; when it does not, the event is about the address
 * the email was sent to.
 */
export function affectedAddresses(
  eventType: string,
  body: {bounce?: {bouncedRecipients?: unknown}; complaint?: {complainedRecipients?: unknown}},
  sentTo: string,
): string[] {
  const listed = eventType === 'Complaint' ? body.complaint?.complainedRecipients : body.bounce?.bouncedRecipients;
  const addresses = Array.isArray(listed)
    ? (listed as {emailAddress?: unknown}[])
        .map(recipient => (typeof recipient?.emailAddress === 'string' ? bareAddress(recipient.emailAddress) : ''))
        .filter(Boolean)
    : [];

  return addresses.length > 0 ? addresses : [bareAddress(sentTo)];
}

const EMAIL_INCLUDE = {contact: true, project: true, campaign: {select: {name: true}}} as const;
export type MatchedEmail = Prisma.EmailGetPayload<{include: typeof EMAIL_INCLUDE}>;

/**
 * What an event is about: its email; nothing yet, so SNS should deliver it again (`retry`); or no
 * email at all (`unmatched`), whose bounce or complaint `suppressUnmatched` still acts on.
 */
export type EventMatch = {kind: 'email'; email: MatchedEmail} | {kind: 'retry'} | {kind: 'unmatched'};

function withinRetryWindow(mail: SesMail): boolean {
  // A timestamp in the future (a skewed clock) is not trusted beyond a minute
  const age = Date.now() - Date.parse(mail.timestamp ?? '');
  return Number.isFinite(age) && age > -60_000 && age < UNMATCHED_EVENT_RETRY_MS;
}

/**
 * Whether an event leaves the status of its email as it is: its send is not recorded -- failed as
 * possibly sent, or still PENDING or SENDING long after SES took it (see matchEmail) -- and whether
 * it counts as sent is the send path's to say. Only the event's marks are written.
 */
export function keepsSendStatus(email: {status: EmailStatus; sentAt: Date | null}): boolean {
  return (
    email.status === EmailStatus.PENDING ||
    email.status === EmailStatus.SENDING ||
    (email.status === EmailStatus.FAILED && !email.sentAt)
  );
}

/**
 * The email an event is about: by the messageId the send path stored, or else by the email id SES
 * repeats from the tags -- when recording the send failed, or it was failed as possibly sent. A
 * row found that way must be of the tagged project, and the tag is enough: a contact may have
 * changed address since. Only a workflow email to a custom recipient must have gone to it.
 *
 * - Still PENDING or SENDING: its send is being recorded, so the event waits for it within the
 *   window. After it, the event is applied to the row without touching its status (and its
 *   bounce or complaint suppresses the address), which is left to the send path.
 * - Otherwise its messageId is stored, and only that. That alone counts it in the rates
 *   (RATED_EMAIL), as SES took it; its status is the send path's to say.
 *
 * Without a row, an email that had tags is gone (a deleted contact) or never had one (a test
 * send, an alert), and waiting will not change that. An untagged one, sent before tags existed,
 * waits within the window as it always did.
 */
export async function matchEmail(mail: SesMail): Promise<EventMatch> {
  const byMessageId = await prisma.email.findUnique({where: {messageId: mail.messageId}, include: EMAIL_INCLUDE});
  if (byMessageId) {
    return {kind: 'email', email: byMessageId};
  }

  const tags = sesTags(mail);
  if (tags.emailId) {
    const email = await prisma.email.findUnique({where: {id: tags.emailId}, include: EMAIL_INCLUDE});
    // A workflow's custom recipient, or '' for the contact
    const override = email ? recipientAddress(email.headers, '').trim().toLowerCase() : '';
    if (
      !email ||
      email.projectId !== tags.projectId ||
      (override && !mail.destination?.some(address => bareAddress(address) === override))
    ) {
      return {kind: 'unmatched'};
    }

    if (email.status === EmailStatus.PENDING || email.status === EmailStatus.SENDING) {
      return withinRetryWindow(mail) ? {kind: 'retry'} : {kind: 'email', email};
    }

    if (!email.messageId) {
      const stamped = await prisma.email.updateMany({
        where: {id: email.id, messageId: null},
        data: {messageId: mail.messageId},
      });
      // Deleted in between: no email to record the event on
      if (stamped.count === 0 && !(await prisma.email.findUnique({where: {id: email.id}, select: {id: true}}))) {
        return {kind: 'unmatched'};
      }
    }
    return {kind: 'email', email: {...email, messageId: email.messageId ?? mail.messageId}};
  }

  if (tags.kind === 'test' || tags.kind === 'alert') {
    return {kind: 'unmatched'};
  }
  return withinRetryWindow(mail) ? {kind: 'retry'} : {kind: 'unmatched'};
}

/**
 * The project an event without an email belongs to: the tagged one, as long as the sender's domain
 * is verified in it, or else the one project with the sender's domain verified. Undefined when
 * neither says. A tag alone is not trusted: whoever sends through the same account could put any.
 */
async function unmatchedProject(tags: Partial<SesMessageTags>, mail: SesMail): Promise<string | undefined> {
  const domain = bareAddress(mail.source ?? '').split('@')[1];
  if (!domain) {
    return undefined;
  }

  if (tags.projectId) {
    const tagged = await prisma.domain.findFirst({
      where: {projectId: tags.projectId, domain, verified: true},
      select: {projectId: true},
    });
    if (tagged) {
      return tagged.projectId;
    }
  }

  const domains = await prisma.domain.findMany({
    where: {domain, verified: true},
    select: {projectId: true},
    distinct: ['projectId'],
    take: 2,
  });
  return domains.length === 1 ? domains[0]!.projectId : undefined;
}

/**
 * Plunk Lite: the contacts a bounce or complaint takes off the list, and so the ones whose
 * unsubscribe it announces. A snoozed contact is `subscribed: false` but coming back, so it is
 * still on the list; one already unsubscribed is not, and hears nothing again.
 */
export const ON_THE_LIST: Prisma.ContactWhereInput = {OR: [{subscribed: true}, {snoozedUntil: {not: null}}]};

/**
 * A permanent bounce or a complaint whose email cannot be found (its contact was deleted, it was a
 * test send or an alert, or its messageId was never stored) still takes the address off the
 * project's list: it is suppressed and any contact with it unsubscribed, which tracks their
 * `contact.unsubscribed`. The project hears about it, except for its own test sends and alerts.
 * Other events of no email are only logged.
 *
 * Throws if recording fails, so SNS delivers the event again.
 */
export async function suppressUnmatched(
  eventType: SesEventType,
  body: {bounce?: {bounceType?: unknown; bouncedRecipients?: unknown}; complaint?: {complainedRecipients?: unknown}},
  mail: SesMail,
): Promise<void> {
  const tags = sesTags(mail);
  const suppresses = eventType === 'Complaint' || (eventType === 'Bounce' && body.bounce?.bounceType === 'Permanent');
  if (!suppresses) {
    signale.info(`[WEBHOOK] ${eventType} event for unknown messageId ${mail.messageId}, nothing to record`);
    return;
  }

  // Mail to the SES mailbox simulator never leaves AWS, and is never suppressed
  const addresses = affectedAddresses(eventType, body, sentAddress(mail, '')).filter(
    address => address && !isMailboxSimulatorAddress(address),
  );
  if (addresses.length === 0) {
    signale.info(
      `[WEBHOOK] ${eventType} event for unknown messageId ${mail.messageId} is about no address to suppress`,
    );
    return;
  }
  const projectId = await unmatchedProject(tags, mail);
  if (!projectId) {
    // Error level: an event that matches no email and no project is lost. A run of these means
    // the send path is not stamping `messageId`, or a sender domain is shared between projects.
    signale.error(`[WEBHOOK] ${eventType} event dropped — no email or project found for messageId ${mail.messageId}`);
    // Every project hears about it, without the address, which may be another project's contact
    await FailureAlertService.recordForAll({
      sourceKey: 'sns:unmatched',
      label: 'SES events without an email',
      error: `A ${eventType === 'Complaint' ? 'complaint' : 'permanent bounce'} from ${mail.source ? bareAddress(mail.source) : 'an unknown sender'} matched no email and no single project (SES message ${mail.messageId}), so its address was not suppressed. Check that each sending domain is verified in one project only.`,
    });
    return;
  }

  const reason = eventType === 'Complaint' ? 'COMPLAINT' : 'BOUNCE';
  const unsubscribed = await prisma.$transaction(async tx => {
    await SuppressionService.record(tx, projectId, addresses, reason, null);
    // Only the contacts this takes off the list, so a copy of the event tells nobody twice. See
    // SNOOZE_CLEARED_ON_WRITE in ContactService.
    return tx.contact.updateManyAndReturn({
      where: {projectId, email: {in: addresses}, AND: [ON_THE_LIST]},
      data: {subscribed: false, snoozedUntil: null},
      select: {id: true},
    });
  }, SES_EVENT_TRANSACTION);
  signale.warn(
    `[WEBHOOK] ${eventType} for ${addresses.join(', ')} matched no email, suppressed in project ${projectId}`,
  );

  // Their unsubscribe, as an email's bounce or complaint tracks it. Lost if queueing fails: the
  // suppression is recorded, and a redelivery would find no one left to unsubscribe.
  try {
    for (const {id} of unsubscribed) {
      await QueueService.queueEventTracking(
        {
          projectId,
          eventName: 'contact.unsubscribed',
          contactId: id,
          data: {reason: (reason === 'COMPLAINT' ? 'complaint' : 'bounce') satisfies SubscriptionChangeReason},
        },
        undefined,
      );
    }
  } catch (error) {
    signale.error(
      `[WEBHOOK] ${eventType} for ${addresses.join(', ')} recorded, but queueing contact.unsubscribed failed:`,
      error,
    );
  }

  if (tags.kind !== 'test' && tags.kind !== 'alert') {
    await FailureAlertService.record(projectId, {
      sourceKey: 'sns:unmatched',
      label: 'SES events without an email',
      error: `A ${reason === 'COMPLAINT' ? 'complaint' : 'permanent bounce'} matched no email of the project (SES message ${mail.messageId}): the address was suppressed and its contacts unsubscribed.`,
      contactEmail: addresses[0],
    });
  }
}

/**
 * SES took the email and then refused to deliver it, for what it contained (a virus): the email
 * failed, under the source that sent it. Nothing is said about the address, which is fine. Only a
 * row whose send is recorded (SENT) moves; `matchEmail` makes the event wait for one still being
 * sent.
 */
export async function recordReject(email: MatchedEmail, reason: unknown): Promise<void> {
  const error = `Rejected by SES: ${typeof reason === 'string' && reason ? reason : 'no reason given'}`;
  const failed = await prisma.email.updateMany({
    where: {id: email.id, status: EmailStatus.SENT},
    data: {status: EmailStatus.FAILED, error},
  });
  if (failed.count === 0) {
    signale.info(`[WEBHOOK] Reject for email ${email.id} in status ${email.status}, nothing to record`);
    return;
  }

  signale.warn(`[WEBHOOK] Email ${email.id} of project ${email.projectId} was rejected by SES: ${error}`);
  await FailureAlertService.recordEmail(email, error);
  if (email.campaignId) {
    await CampaignService.markStatsDirty(email.campaignId);
  }
}

/** Why the webhook turned an SNS delivery away */
type SnsRejection = 'signature' | 'topic';

/**
 * Deliveries the webhook rejected, kept for the check of the event pipeline: when each reason was
 * last seen (`SNS_REJECTS_KEY`, reason → time) and how many there were each hour
 * (`snsRejectsHourKey(hour)`, reason → count). Nothing is alerted from here, since anyone can post
 * a rejected delivery.
 */
export const SNS_REJECTS_KEY = 'plunk-lite:sns:rejects';
const snsRejectsHourKey = (hour: string) => `plunk-lite:sns:rejects:${hour}`;
const REJECTS_SECONDS = 7 * 86400;
const REJECTS_HOUR_SECONDS = 48 * 3600;

export async function noteSnsRejection(reason: SnsRejection): Promise<void> {
  const now = new Date().toISOString();
  const hourKey = snsRejectsHourKey(now.slice(0, 13));
  try {
    await redis
      .multi()
      .hset(SNS_REJECTS_KEY, reason, now)
      .expire(SNS_REJECTS_KEY, REJECTS_SECONDS)
      .hincrby(hourKey, reason, 1)
      .expire(hourKey, REJECTS_HOUR_SECONDS)
      .exec();
  } catch (error) {
    signale.warn(`[WEBHOOK] Could not note an SNS delivery rejected for its ${reason}:`, error);
  }
}

/** The rejected deliveries of the last `hours`, by reason, as the pipeline check reports them */
async function recentRejections(hours: number): Promise<string> {
  try {
    const now = Date.now();
    const counts: Partial<Record<SnsRejection, number>> = {};
    for (let i = 0; i < hours; i++) {
      const hour = new Date(now - i * 3_600_000).toISOString().slice(0, 13);
      for (const [reason, count] of Object.entries(await redis.hgetall(snsRejectsHourKey(hour)))) {
        counts[reason as SnsRejection] = (counts[reason as SnsRejection] ?? 0) + Number(count);
      }
    }
    const lastSeen = await redis.hgetall(SNS_REJECTS_KEY);
    const reasons = (Object.keys(counts) as SnsRejection[]).map(
      reason => `${counts[reason]} for their ${reason} (last at ${lastSeen[reason] ?? 'an unknown time'})`,
    );
    return reasons.length > 0
      ? ` The webhook rejected SNS deliveries in the last ${hours} hours: ${reasons.join(', ')}.`
      : ` The webhook rejected no SNS delivery in the last ${hours} hours: check the event destination of the configuration set and the topic's subscription.`;
  } catch (error) {
    signale.warn('[WEBHOOK] Could not read the rejected SNS deliveries:', error);
    return '';
  }
}

/** Emails a project needs in the window before its share without events means anything */
const PIPELINE_MIN_EMAILS = 20;
const PIPELINE_STUCK_SHARE = 0.5;
const PIPELINE_WINDOW_HOURS = 6;
/** How long SES may take to report on an email before it counts as without events */
const PIPELINE_GRACE_HOURS = 1;

/**
 * Whether SES events are reaching the webhook, for each project: of the emails SES accepted between
 * one and six hours ago, half or more still SENT -- no delivery, bounce or complaint recorded, which
 * both configuration sets publish -- means they are not. The project is told, with what the webhook
 * rejected meanwhile; once its emails get their events again, or it has sent too few to say, the
 * notice is closed.
 */
export async function checkEventPipeline(): Promise<void> {
  const now = Date.now();
  const from = utcTimestamp(new Date(now - PIPELINE_WINDOW_HOURS * 3_600_000));
  const to = utcTimestamp(new Date(now - PIPELINE_GRACE_HOURS * 3_600_000));
  const rows = await prisma.$queryRaw<{projectId: string; total: number; stuck: number}[]>`
    SELECT "projectId", count(*)::int AS "total",
           (count(*) FILTER (WHERE "status" = ${EmailStatus.SENT}::"EmailStatus"))::int AS "stuck"
    FROM "emails"
    WHERE "createdAt" >= ${from}
      AND "createdAt" < ${to}
      AND "sentAt" < ${to}
      AND "messageId" IS NOT NULL
      AND "simulated" = false
    GROUP BY "projectId"`;

  let rejections: string | undefined;
  const stuckProjects = new Set<string>();
  for (const {projectId, total, stuck} of rows) {
    if (total < PIPELINE_MIN_EMAILS || stuck / total < PIPELINE_STUCK_SHARE) {
      continue;
    }
    stuckProjects.add(projectId);
    rejections ??= await recentRejections(PIPELINE_WINDOW_HOURS);
    signale.error(`[WEBHOOK] ${stuck} of ${total} recent emails of project ${projectId} have no SES event`);
    await FailureAlertService.record(projectId, {
      sourceKey: 'sns:events',
      label: 'SES events not arriving',
      error: `${stuck} of the ${total} emails SES accepted between ${PIPELINE_GRACE_HOURS} and ${PIPELINE_WINDOW_HOURS} hours ago have had no delivery, bounce or complaint reported: SES events are not reaching Plunk, so bounces are not being suppressed.${rejections}`,
    });
  }

  // Every other notice is closed: its project's emails get their events again, or it sent too few
  // in the window (none at all, perhaps) to say they do not
  const notices = await prisma.plunkLiteFailure.findMany({where: {sourceKey: 'sns:events'}, select: {projectId: true}});
  for (const {projectId} of notices) {
    if (!stuckProjects.has(projectId)) {
      await FailureAlertService.resolve('sns:events', projectId);
    }
  }
}

/**
 * At startup: every project hears about a configuration set that does not publish its bounces,
 * complaints and deliveries to SNS (see verifyConfigurationSets), and the notice is closed once
 * they all do. Nothing changes when SES could not be asked. Never throws.
 */
export async function checkConfigurationSets(): Promise<void> {
  const problems = await verifyConfigurationSets();
  if (!problems) {
    return;
  }
  if (problems.length === 0) {
    await FailureAlertService.resolve('sns:config');
    return;
  }
  await FailureAlertService.recordForAll({
    sourceKey: 'sns:config',
    label: 'SES configuration sets',
    error: problems.join(' '),
  });
}
