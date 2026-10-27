import type {Prisma} from '@plunk/db';
import type {ContactSuppression, SuppressionReason} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ConflictError, ErrorCode} from '../exceptions/index.js';
import {normalizeEmail} from '../utils/emailAddress.js';

type Suppression = ContactSuppression;

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * A request to subscribe an address that is suppressed, made by someone who asked for exactly
 * that: the contact page, an update of that contact, or the dashboard's add-contact form
 */
export class SuppressedAddressError extends ConflictError {
  public constructor(email: string, suppression: Suppression) {
    super(
      `${email} cannot be subscribed: it ${suppression.reason === 'COMPLAINT' ? 'reported an email as spam' : 'bounced'} on ${suppression.createdAt.toISOString().slice(0, 10)}. Remove the suppression on its contact page (adding the contact unsubscribed first, if there is none) to subscribe it again.`,
      {suppression},
      ErrorCode.ADDRESS_SUPPRESSED,
    );
  }
}

/**
 * Plunk Lite's own suppression list: addresses a project must not email again after a permanent
 * bounce or a complaint. Plunk only unsubscribes the contact, which many paths can undo; this is
 * kept by address and checked wherever a contact is subscribed and before every send.
 */
export class SuppressionService {
  /**
   * Record addresses as suppressed, from the email whose bounce or complaint it was -- or none,
   * for an import that says the address bounced or complained elsewhere. A complaint on an
   * address suppressed for a bounce replaces the reason; anything else recorded stays as it is.
   */
  public static async record(
    db: Db,
    projectId: string,
    addresses: string[],
    reason: SuppressionReason,
    emailId: string | null,
  ): Promise<void> {
    for (const email of new Set(addresses.map(normalizeEmail).filter(Boolean))) {
      await db.$executeRaw`
        INSERT INTO "plunk_lite_suppressions" ("projectId", "email", "reason", "emailId")
        VALUES (${projectId}, ${email}, ${reason}, ${emailId})
        ON CONFLICT ("projectId", "email") DO UPDATE
          SET "reason" = EXCLUDED."reason", "emailId" = EXCLUDED."emailId", "createdAt" = now()
        WHERE "plunk_lite_suppressions"."reason" = 'BOUNCE' AND EXCLUDED."reason" = 'COMPLAINT'`;
    }
  }

  /** The suppressed ones among these addresses, by normalized address */
  public static async suppressedAmong(projectId: string, addresses: string[]): Promise<Map<string, Suppression>> {
    const emails = [...new Set(addresses.map(normalizeEmail))];
    if (emails.length === 0) {
      return new Map();
    }

    const rows = await prisma.plunkLiteSuppression.findMany({
      where: {projectId, email: {in: emails}},
      select: {email: true, reason: true, createdAt: true},
    });

    return new Map(rows.map(row => [row.email, {reason: row.reason as SuppressionReason, createdAt: row.createdAt}]));
  }

  /** Split contacts, of one project or several, into those that may be subscribed and those that may not */
  public static async partition<T extends {projectId: string; email: string}>(
    contacts: T[],
  ): Promise<{allowed: T[]; suppressed: T[]}> {
    const byProject = new Map<string, T[]>();
    for (const contact of contacts) {
      byProject.set(contact.projectId, [...(byProject.get(contact.projectId) ?? []), contact]);
    }

    const allowed: T[] = [];
    const suppressed: T[] = [];
    for (const [projectId, group] of byProject) {
      const listed = await this.suppressedAmong(
        projectId,
        group.map(contact => contact.email),
      );
      for (const contact of group) {
        (listed.has(normalizeEmail(contact.email)) ? suppressed : allowed).push(contact);
      }
    }

    if (suppressed.length > 0) {
      signale.info(`[SUPPRESSION] ${suppressed.length} suppressed contact(s) left unsubscribed`);
    }

    return {allowed, suppressed};
  }

  public static async find(projectId: string, address: string): Promise<Suppression | null> {
    return (await this.suppressedAmong(projectId, [address])).get(normalizeEmail(address)) ?? null;
  }

  /**
   * Whether a write may subscribe this address. An explicit request (`explicit`) for a suppressed
   * address is refused with SuppressedAddressError; any other gets `false`, so the caller leaves
   * the contact unsubscribed -- an event, an import, a workflow subscribing in passing.
   */
  public static async maySubscribe(projectId: string, address: string, {explicit = false} = {}): Promise<boolean> {
    const suppression = await this.find(projectId, address);
    if (!suppression) {
      return true;
    }
    if (explicit) {
      throw new SuppressedAddressError(normalizeEmail(address), suppression);
    }

    signale.info(
      `[SUPPRESSION] ${normalizeEmail(address)} stays unsubscribed: suppressed after a ${suppression.reason.toLowerCase()}`,
    );
    return false;
  }

  /** Remove an address from the list, so it can be subscribed and emailed again */
  public static async lift(projectId: string, address: string): Promise<boolean> {
    const removed = await prisma.plunkLiteSuppression.deleteMany({where: {projectId, email: normalizeEmail(address)}});
    if (removed.count > 0) {
      signale.info(`[SUPPRESSION] Lifted the suppression of ${normalizeEmail(address)} in project ${projectId}`);
    }
    return removed.count > 0;
  }
}
