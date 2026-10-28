import {createHash, randomBytes} from 'node:crypto';

import {type Contact, Prisma} from '@plunk/db';
import {contactLanguage, optInEmail, toOptInTexts} from '@plunk/shared';
import type {OptInLink, OptInOutcome, OptInRequestInfo, OptInSettingsData} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import signale from 'signale';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';
import {normalizeEmail} from '../utils/emailAddress.js';
import {BrandService} from './BrandService.js';
import {DomainService} from './DomainService.js';
import {EmailService} from './EmailService.js';
import {EventService} from './EventService.js';
import {FailureAlertService} from './FailureAlertService.js';
import {SegmentMembershipService} from './SegmentMembershipService.js';
import {SuppressionService} from './SuppressionService.js';

/** Which key asked for the sign-up: anyone can read the public one in a page, so it sends no email */
export type OptInKey = 'public' | 'secret';

// A contact gets at most one confirmation email every 15 minutes and 3 a day; after 3 in a row
// without a confirmation, none for 30 days. A project emails at most 500 contacts an hour and
// sends at most 5000 confirmation emails a day
const RESEND_AFTER = '15 minutes';
const SENDS_PER_DAY = 3;
const UNANSWERED_MAX = 3;
const SILENCE_AFTER_UNANSWERED = '30 days';
const PROJECT_CONTACTS_PER_HOUR = 500;
const PROJECT_SENDS_PER_DAY = 5000;

// Deleted contacts' requests are removed lazily, at most once an hour per project and process
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const cleanedAt = new Map<string, number>();

// Timestamps are stored without a zone, in UTC, like Plunk Lite's other raw writes
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
// A hash no token has: the link a request had stops working
const deadHash = () => `dead-${randomBytes(16).toString('hex')}`;

/**
 * The `pending` status, on a request `r` joined to its contact `c`: a request neither confirmed nor
 * withdrawn, for the contact's address as it is now, of a contact not subscribed, not snoozed and
 * whose address is not suppressed
 */
const PENDING = Prisma.sql`r."confirmedAt" IS NULL AND r."withdrawnAt" IS NULL AND r."email" = c."email"
  AND c."subscribed" = false AND c."snoozedUntil" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "plunk_lite_suppressions" s WHERE s."projectId" = c."projectId" AND s."email" = c."email")`;

/**
 * Plunk Lite's double opt-in. With it on, a sign-up from the API (an event, a contact created or
 * updated with a key, a transactional send that subscribes) leaves the contact unsubscribed and
 * emails a link to confirm; the contact is subscribed -- and `contact.subscribed` fires, starting
 * its workflows -- only when they open it and press the button. Until then the contact shows as
 * waiting for confirmation, for as long as it takes.
 */
export class OptInService {
  /** The project's settings, or the defaults (off) */
  public static async settings(projectId: string): Promise<OptInSettingsData> {
    const row = await prisma.plunkLiteOptInSettings.findUnique({where: {projectId}});
    return {
      enabled: row?.enabled ?? false,
      fromEmail: row?.fromEmail ?? null,
      fromName: row?.fromName ?? null,
      // Read through the same checks as a request, whatever the row holds
      texts: toOptInTexts(row?.texts).texts,
    };
  }

  /** Whether sign-ups to this project wait for confirmation */
  public static async isRequired(projectId: string): Promise<boolean> {
    const row = await prisma.plunkLiteOptInSettings.findUnique({
      where: {projectId},
      select: {enabled: true, fromEmail: true},
    });
    return Boolean(row?.enabled && row.fromEmail);
  }

  /**
   * Saves the project's settings from untrusted data. Anything that cannot be kept is refused with
   * the reason; turning it on needs a sender on a verified domain of the project.
   */
  public static async saveSettings(projectId: string, value: unknown): Promise<OptInSettingsData> {
    const data = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const {texts, errors} = toOptInTexts(data.texts);
    if (errors.length > 0) {
      throw new HttpException(400, errors.join('; '), ErrorCode.VALIDATION_ERROR);
    }

    const enabled = data.enabled === true;
    const fromEmail =
      typeof data.fromEmail === 'string' && data.fromEmail.trim() ? normalizeEmail(data.fromEmail) : null;
    const fromName =
      typeof data.fromName === 'string' && data.fromName.trim() ? data.fromName.trim().slice(0, 100) : null;
    if (enabled && !fromEmail) {
      throw new HttpException(400, 'Choose the address the confirmation emails come from', ErrorCode.VALIDATION_ERROR);
    }
    // Checked only to turn it on: switching it off must work while the sender's domain is down
    if (enabled && fromEmail) {
      await DomainService.verifyEmailDomain(fromEmail, projectId);
    }

    const row = {enabled, fromEmail, fromName, texts: toPrismaJson(texts)};
    await prisma.plunkLiteOptInSettings.upsert({where: {projectId}, create: {projectId, ...row}, update: row});
    return {enabled, fromEmail, fromName, texts};
  }

  /**
   * Whether a confirmation email may go to this contact for a sign-up no key stands behind (the
   * public subscribe page, a workflow step that an event with the public key may have started):
   * only if it is waiting to confirm one already, so this resends its link. Otherwise anyone could
   * have the project email any address -- someone who unsubscribed included -- with the contact
   * ids the public key hands out. A contact that received an email subscribes from its own link.
   */
  public static async mayAskWithoutKey(contactId: string): Promise<boolean> {
    const contact = await prisma.contact.findUnique({where: {id: contactId}, select: {projectId: true}});
    return contact ? (await this.pendingAmong(contact.projectId, [contactId])).has(contactId) : false;
  }

  /**
   * Asks a contact to confirm a sign-up: one confirmation email with a new link, unless the
   * contact's or the project's limits say otherwise. `segmentIds` are joined on confirming. Never
   * throws: the contact stays unsubscribed, which is the safe side, and the outcome says why.
   */
  public static async request(
    contact: Pick<Contact, 'id' | 'projectId' | 'email' | 'data'>,
    {segmentIds = [], key = 'secret'}: {segmentIds?: string[]; key?: OptInKey} = {},
  ): Promise<OptInOutcome> {
    if (key === 'public') {
      return 'held';
    }
    try {
      return await this.ask(contact, segmentIds);
    } catch (error) {
      signale.error(`[OPT-IN] Could not ask ${contact.email} to confirm a sign-up:`, error);
      return 'failed';
    }
  }

  /** What the confirmation page shows for a link */
  public static async describe(token: string): Promise<OptInLink> {
    const found = await this.find(token);
    if (!found) {
      return {status: 'invalid'};
    }
    const {request, contact} = found;
    const project = await prisma.project.findUnique({
      where: {id: contact.projectId},
      select: {name: true, language: true},
    });
    if (!project || (await SuppressionService.find(contact.projectId, contact.email))) {
      return {status: 'invalid'};
    }

    return {
      status: request.confirmedAt || contact.subscribed ? 'confirmed' : 'pending',
      projectName: project.name,
      email: contact.email,
      language: contactLanguage(contact.data, project.language),
    };
  }

  /**
   * Confirms a sign-up from its link: adds the contact to the segments it signed up to, subscribes
   * it and fires `contact.subscribed` (with no `reason`, as a sign-up). Only the first press of the
   * button does; a contact already subscribed meanwhile is left as it is.
   */
  public static async confirm(token: string): Promise<'confirmed' | 'invalid'> {
    const found = await this.find(token);
    if (!found) {
      return 'invalid';
    }
    const {request, contact} = found;
    // An address that bounced or complained since is not subscribed by an old link
    if (!(await SuppressionService.maySubscribe(contact.projectId, contact.email))) {
      return 'invalid';
    }

    const result = await prisma.$transaction(async tx => {
      const [claimed] = await tx.$queryRaw<{segmentIds: string[]; emailId: string | null}[]>`
        UPDATE "plunk_lite_optin_requests" SET "confirmedAt" = ${NOW}, "unanswered" = 0
        WHERE "contactId" = ${contact.id} AND "tokenHash" = ${request.tokenHash}
          AND "confirmedAt" IS NULL AND "withdrawnAt" IS NULL
        RETURNING "segmentIds", "emailId"`;
      if (!claimed) {
        return null;
      }
      // See SNOOZE_CLEARED_ON_WRITE in ContactService
      const {count} = await tx.contact.updateMany({
        where: {id: contact.id, subscribed: false},
        data: {subscribed: true, snoozedUntil: null},
      });
      return {...claimed, subscribed: count === 1};
    });
    if (!result) {
      // Pressed twice, or meanwhile replaced by a newer email or withdrawn by an unsubscribe
      const now = await prisma.plunkLiteOptInRequest.findUnique({where: {contactId: contact.id}});
      return now?.tokenHash === request.tokenHash && now.confirmedAt && !now.withdrawnAt ? 'confirmed' : 'invalid';
    }
    if (!result.subscribed) {
      return 'confirmed';
    }

    // Into its segments before the event, so the workflows `contact.subscribed` starts see it there
    // (as /v1/track does), and their entry events after it
    const segments =
      result.segmentIds.length > 0
        ? await prisma.segment.findMany({
            where: {projectId: contact.projectId, id: {in: result.segmentIds}, type: 'STATIC'},
          })
        : [];
    const entries = await SegmentMembershipService.enterSegments(contact.projectId, segments, [contact.id]);
    try {
      // Unsubscribed in the moment since: the decision stands, and no sign-up is told after it
      const now = await prisma.contact.findUnique({where: {id: contact.id}, select: {subscribed: true}});
      if (!now?.subscribed) {
        return 'confirmed';
      }
      const emailId = result.emailId
        ? ((await prisma.email.findUnique({where: {id: result.emailId}, select: {id: true}}))?.id ?? undefined)
        : undefined;
      await EventService.trackEvent(contact.projectId, 'contact.subscribed', contact.id, emailId);
    } finally {
      await SegmentMembershipService.fireEntryEvents(contact.projectId, entries);
    }

    return 'confirmed';
  }

  /**
   * Withdraws the confirmation requests of these contacts: called before a contact is written as
   * unsubscribed or snoozed, so a link opened afterwards does not undo the decision. The request is
   * kept, with its limits, until a new sign-up asks again.
   */
  public static async cancel(contactIds: string | string[]): Promise<void> {
    const ids = Array.isArray(contactIds) ? contactIds : [contactIds];
    if (ids.length > 0) {
      await prisma.$executeRaw`
        UPDATE "plunk_lite_optin_requests"
        SET "withdrawnAt" = ${NOW}, "tokenHash" = 'dead-' || md5(random()::text || clock_timestamp()::text || "contactId")
        WHERE "contactId" = ANY(${ids}::text[]) AND "withdrawnAt" IS NULL`;
    }
  }

  /** The contact's request, as its page in the dashboard shows it */
  public static async requestFor(contactId: string): Promise<OptInRequestInfo | null> {
    return prisma.plunkLiteOptInRequest.findUnique({
      where: {contactId},
      select: {createdAt: true, lastSentAt: true, sends: true, confirmedAt: true, withdrawnAt: true},
    });
  }

  /** Which of these contacts of the project wait for confirmation (one page or batch) */
  public static async pendingAmong(projectId: string, contactIds: string[]): Promise<Set<string>> {
    if (contactIds.length === 0) {
      return new Set();
    }
    const rows = await prisma.$queryRaw<{contactId: string}[]>`
      SELECT r."contactId" FROM "plunk_lite_optin_requests" r
      JOIN "contacts" c ON c."id" = r."contactId"
      WHERE r."projectId" = ${projectId} AND r."contactId" = ANY(${contactIds}::text[]) AND ${PENDING}`;
    return new Set(rows.map(row => row.contactId));
  }

  /**
   * The contacts waiting for confirmation, as `ContactService.list` pages any other status: the
   * same search, segment, sort and cursor. A query of its own, since the status lives in Plunk
   * Lite's table.
   */
  public static async listPending(
    projectId: string,
    {
      limit = 20,
      cursor,
      search,
      segmentId,
      sort,
      dir,
    }: {
      limit?: number;
      cursor?: string;
      search?: string;
      segmentId?: string;
      sort?: 'email' | 'createdAt';
      dir?: 'asc' | 'desc';
    },
  ): Promise<{data: Contact[]; total: number; cursor?: string; hasMore: boolean}> {
    const name = sort === 'email' ? '"email"' : '"createdAt"';
    const column = Prisma.raw(`c.${name}`);
    const ascending = dir === 'asc';
    const conditions: Prisma.Sql[] = [
      Prisma.sql`c."projectId" = ${projectId}`,
      Prisma.sql`r."projectId" = ${projectId}`,
      PENDING,
    ];
    if (search) {
      // As Prisma's case-insensitive `contains`: the search is a substring, not a pattern
      conditions.push(Prisma.sql`c."email" ILIKE ${`%${search.replace(/[\\%_]/g, char => `\\${char}`)}%`}`);
    }
    if (segmentId) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "segment_memberships" m
        WHERE m."contactId" = c."id" AND m."segmentId" = ${segmentId} AND m."exitedAt" IS NULL)`);
    }
    const filter = Prisma.join(conditions, ' AND ');

    // After the cursor's row in the list's order: the sort column, then `id` descending. Its value
    // is read by the database, so it compares as stored; a cursor whose contact is gone ends the list
    let after = Prisma.empty;
    if (cursor) {
      if (!(await prisma.contact.findFirst({where: {id: cursor, projectId}, select: {id: true}}))) {
        return {data: [], total: 0, hasMore: false};
      }
      const value = Prisma.sql`(SELECT ${Prisma.raw(name)} FROM "contacts" WHERE "id" = ${cursor})`;
      after = ascending
        ? Prisma.sql` AND (${column} > ${value} OR (${column} = ${value} AND c."id" < ${cursor}))`
        : Prisma.sql` AND (${column} < ${value} OR (${column} = ${value} AND c."id" < ${cursor}))`;
    }

    const ids = await prisma.$queryRaw<{id: string}[]>`
      SELECT c."id" FROM "contacts" c
      JOIN "plunk_lite_optin_requests" r ON r."contactId" = c."id"
      WHERE ${filter}${after}
      ORDER BY ${column} ${Prisma.raw(ascending ? 'ASC' : 'DESC')}, c."id" DESC
      LIMIT ${limit + 1}`;

    const hasMore = ids.length > limit;
    const pageIds = ids.slice(0, limit).map(row => row.id);
    const byId = new Map(
      (await prisma.contact.findMany({where: {id: {in: pageIds}}})).map(contact => [contact.id, contact]),
    );
    const data = pageIds.flatMap(id => byId.get(id) ?? []);

    let total = 0;
    if (!cursor) {
      const [row] = await prisma.$queryRaw<{total: bigint}[]>`
        SELECT count(*) AS "total" FROM "contacts" c
        JOIN "plunk_lite_optin_requests" r ON r."contactId" = c."id"
        WHERE ${filter}`;
      total = Number(row?.total ?? 0);
    }

    return {data, total, cursor: hasMore ? pageIds[pageIds.length - 1] : undefined, hasMore};
  }

  // The work of `request`, which may throw
  private static async ask(
    contact: Pick<Contact, 'id' | 'projectId' | 'email' | 'data'>,
    segmentIds: string[],
  ): Promise<OptInOutcome> {
    const {projectId} = contact;
    await this.cleanUpDeleted(projectId);

    const [usage] = await prisma.$queryRaw<{contacts: bigint; sends: bigint | null}[]>`
      SELECT count(*) FILTER (WHERE "lastSentAt" > ${NOW} - interval '1 hour') AS "contacts",
             sum("sends") AS "sends"
      FROM "plunk_lite_optin_requests"
      WHERE "projectId" = ${projectId} AND "lastSentAt" > ${NOW} - interval '1 day'`;
    if (
      Number(usage?.contacts ?? 0) >= PROJECT_CONTACTS_PER_HOUR ||
      Number(usage?.sends ?? 0) >= PROJECT_SENDS_PER_DAY
    ) {
      await FailureAlertService.record(projectId, {
        sourceKey: 'optin',
        label: 'Double opt-in',
        error: `Confirmation emails went to more than ${PROJECT_CONTACTS_PER_HOUR} contacts in an hour, or more than ${PROJECT_SENDS_PER_DAY} were sent in a day: new sign-ups wait unsubscribed, without one. Check the sign-up form for bots.`,
        contactEmail: contact.email,
      });
      await this.keepWaiting(contact, segmentIds);
      return 'capped';
    }

    const settings = await this.settings(projectId);
    if (!settings.fromEmail) {
      await this.keepWaiting(contact, segmentIds);
      return 'failed';
    }

    // Everything that can fail before the claim is checked first, so a failure leaves the request
    // as it was, its last link included
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    let email: {subject: string; body: string};
    try {
      await DomainService.verifyEmailDomain(settings.fromEmail, projectId);
      const project = await prisma.project.findUniqueOrThrow({
        where: {id: projectId},
        select: {name: true, language: true},
      });
      email = optInEmail({
        language: contactLanguage(contact.data, project.language),
        projectName: project.name,
        url: `${DASHBOARD_URI}/confirm#${token}`,
        texts: settings.texts,
        brand: await BrandService.get(projectId),
      });
    } catch (error) {
      await this.keepWaiting(contact, segmentIds);
      return this.failed(contact, error);
    }

    // Claimed in one statement, so sign-ups sent together email once, and the link that goes out
    // is the one that works. A request that does not claim it changes nothing.
    const previous = await prisma.plunkLiteOptInRequest.findUnique({
      where: {contactId: contact.id},
      select: {tokenHash: true, lastSentAt: true, withdrawnAt: true, confirmedAt: true},
    });
    const claimed = await prisma.$queryRaw<{contactId: string}[]>`
      INSERT INTO "plunk_lite_optin_requests" AS r
        ("contactId", "projectId", "email", "tokenHash", "segmentIds", "sends", "windowStart", "unanswered", "lastSentAt", "createdAt")
      VALUES (${contact.id}, ${projectId}, ${contact.email}, ${tokenHash}, ${segmentIds}::text[], 1, ${NOW}, 1, ${NOW}, ${NOW})
      ON CONFLICT ("contactId") DO UPDATE SET
        "projectId" = EXCLUDED."projectId",
        "email" = EXCLUDED."email",
        "tokenHash" = EXCLUDED."tokenHash",
        "segmentIds" = ARRAY(SELECT DISTINCT unnest(r."segmentIds" || EXCLUDED."segmentIds")),
        "confirmedAt" = NULL,
        "withdrawnAt" = NULL,
        "lastSentAt" = ${NOW},
        "sends" = CASE WHEN r."windowStart" <= ${NOW} - interval '1 day' THEN 1 ELSE r."sends" + 1 END,
        "windowStart" = CASE WHEN r."windowStart" <= ${NOW} - interval '1 day' THEN ${NOW} ELSE r."windowStart" END,
        "unanswered" = CASE WHEN r."lastSentAt" <= ${NOW} - ${SILENCE_AFTER_UNANSWERED}::interval THEN 1 ELSE r."unanswered" + 1 END
      WHERE (r."lastSentAt" IS NULL OR r."lastSentAt" <= ${NOW} - ${RESEND_AFTER}::interval)
        AND (r."windowStart" <= ${NOW} - interval '1 day' OR r."sends" < ${SENDS_PER_DAY})
        AND (r."unanswered" < ${UNANSWERED_MAX} OR r."lastSentAt" IS NULL
             OR r."lastSentAt" <= ${NOW} - ${SILENCE_AFTER_UNANSWERED}::interval)
      RETURNING "contactId"`;
    if (claimed.length === 0) {
      // No email now, but the segments of this sign-up join the ones it is waiting with
      await prisma.$executeRaw`
        UPDATE "plunk_lite_optin_requests"
        SET "segmentIds" = ARRAY(SELECT DISTINCT unnest("segmentIds" || ${segmentIds}::text[]))
        WHERE "contactId" = ${contact.id} AND "email" = ${contact.email}
          AND "confirmedAt" IS NULL AND "withdrawnAt" IS NULL`;
      return 'throttled';
    }

    let sent;
    try {
      sent = await EmailService.sendTransactionalEmail({
        projectId,
        contactId: contact.id,
        subject: email.subject,
        body: email.body,
        from: settings.fromEmail,
        fromName: settings.fromName ?? undefined,
      });
    } catch (error) {
      // Give the claim back as it was -- the last link, its time, its limits -- so the link in the
      // contact's mailbox still works and the next sign-up tries again
      await prisma.$executeRaw`
        UPDATE "plunk_lite_optin_requests"
        SET "tokenHash" = ${previous?.tokenHash ?? deadHash()}, "lastSentAt" = ${previous?.lastSentAt ?? null},
            "withdrawnAt" = ${previous?.withdrawnAt ?? null}, "confirmedAt" = ${previous?.confirmedAt ?? null},
            "sends" = GREATEST("sends" - 1, 0), "unanswered" = GREATEST("unanswered" - 1, 0)
        WHERE "contactId" = ${contact.id} AND "tokenHash" = ${tokenHash}`;
      return this.failed(contact, error);
    }

    try {
      await prisma.plunkLiteOptInRequest.updateMany({
        where: {contactId: contact.id, tokenHash},
        data: {emailId: sent.id},
      });
    } catch (error) {
      // The email is on its way: only the link to it in the dashboard is missing
      signale.warn(`[OPT-IN] Could not record the confirmation email ${sent.id} of ${contact.email}:`, error);
    }
    return 'sent';
  }

  /**
   * A sign-up that got no email (the project's limits, or a failure before the claim) still shows
   * as waiting for confirmation, with its segments, and the next sign-up emails it. A live link
   * stays as it was; a used or withdrawn one is replaced by one nobody has. Limits are untouched.
   */
  private static async keepWaiting(
    contact: Pick<Contact, 'id' | 'projectId' | 'email'>,
    segmentIds: string[],
  ): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "plunk_lite_optin_requests" AS r ("contactId", "projectId", "email", "tokenHash", "segmentIds")
      VALUES (${contact.id}, ${contact.projectId}, ${contact.email}, ${deadHash()}, ${segmentIds}::text[])
      ON CONFLICT ("contactId") DO UPDATE SET
        "segmentIds" = ARRAY(SELECT DISTINCT unnest(r."segmentIds" || EXCLUDED."segmentIds")),
        "tokenHash" = CASE WHEN r."confirmedAt" IS NULL AND r."withdrawnAt" IS NULL AND r."email" = EXCLUDED."email"
                           THEN r."tokenHash" ELSE EXCLUDED."tokenHash" END,
        "email" = EXCLUDED."email",
        "confirmedAt" = NULL,
        "withdrawnAt" = NULL`;
  }

  // A confirmation email that could not be queued: logged and alerted on, never thrown
  private static async failed(contact: Pick<Contact, 'projectId' | 'email'>, error: unknown): Promise<OptInOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    signale.warn(`[OPT-IN] Could not send the confirmation email to ${contact.email}: ${message}`);
    await FailureAlertService.record(contact.projectId, {
      sourceKey: 'optin',
      label: 'Double opt-in',
      error: `The confirmation email could not be sent: ${message}`,
      contactEmail: contact.email,
    });
    return 'failed';
  }

  /** The request a link belongs to and its contact, if the link still confirms that address */
  private static async find(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
      return null;
    }
    const request = await prisma.plunkLiteOptInRequest.findUnique({where: {tokenHash: hashToken(token)}});
    if (!request || request.withdrawnAt) {
      return null;
    }
    const contact = await prisma.contact.findUnique({where: {id: request.contactId}});
    if (!contact || contact.projectId !== request.projectId || contact.email !== request.email) {
      return null;
    }
    return {request, contact};
  }

  // Requests of contacts deleted since, removed at most once an hour per project and process
  private static async cleanUpDeleted(projectId: string): Promise<void> {
    const last = cleanedAt.get(projectId) ?? 0;
    if (Date.now() - last < CLEANUP_EVERY_MS) {
      return;
    }
    if (cleanedAt.size >= 1000) {
      cleanedAt.clear();
    }
    cleanedAt.set(projectId, Date.now());
    try {
      await prisma.$executeRaw`
        DELETE FROM "plunk_lite_optin_requests" r
        WHERE r."projectId" = ${projectId}
          AND NOT EXISTS (SELECT 1 FROM "contacts" c WHERE c."id" = r."contactId")`;
    } catch (error) {
      signale.warn(`[OPT-IN] Could not clean up the requests of deleted contacts in project ${projectId}:`, error);
    }
  }
}
