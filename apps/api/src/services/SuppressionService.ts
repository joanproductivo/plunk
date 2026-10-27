import type {Prisma} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ConflictError} from '../exceptions/index.js';
import {normalizeEmail} from '../utils/emailAddress.js';

export type SuppressionReason = 'BOUNCE' | 'COMPLAINT';

export interface Suppression {
  reason: SuppressionReason;
  createdAt: Date;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * A request to subscribe an address that is suppressed, made by someone who asked for exactly
 * that: the contact page, an update of that contact, or the dashboard's add-contact form
 */
export class SuppressedAddressError extends ConflictError {
  public constructor(email: string, suppression: Suppression) {
    super(
      `${email} cannot be subscribed: it ${suppression.reason === 'COMPLAINT' ? 'reported an email as spam' : 'bounced'} on ${suppression.createdAt.toISOString().slice(0, 10)}. Remove the suppression on the contact's page to subscribe it again.`,
      {suppression},
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
   * Record addresses as suppressed. A complaint on an address suppressed for a bounce replaces
   * the reason; anything else already recorded stays as it is.
   */
  public static async record(
    db: Db,
    projectId: string,
    addresses: string[],
    reason: SuppressionReason,
    emailId: string,
  ): Promise<void> {
    for (const email of new Set(addresses.map(normalizeEmail).filter(Boolean))) {
      await db.$executeRaw`
        INSERT INTO "plunk_lite_suppressions" ("projectId", "email", "reason", "emailId")
        VALUES (${projectId}, ${email}, ${reason}, ${emailId})
        ON CONFLICT ("projectId", "email") DO UPDATE SET "reason" = EXCLUDED."reason", "emailId" = EXCLUDED."emailId"
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

  public static async find(projectId: string, address: string): Promise<Suppression | null> {
    return (await this.suppressedAmong(projectId, [address])).get(normalizeEmail(address)) ?? null;
  }

  /** Throw when an explicit subscription would subscribe a suppressed address */
  public static async assertSubscribable(projectId: string, address: string): Promise<void> {
    const suppression = await this.find(projectId, address);
    if (suppression) {
      throw new SuppressedAddressError(normalizeEmail(address), suppression);
    }
  }

  /**
   * The subscription a write may give an address: `false` instead of `true` for a suppressed
   * one, so paths that subscribe in passing -- an event, an import, a workflow -- leave it
   * unsubscribed. Returns the suppression too, so the caller can say why.
   */
  public static async allowedSubscription(
    projectId: string,
    address: string,
    subscribed: boolean | undefined,
  ): Promise<{subscribed: boolean | undefined; suppression: Suppression | null}> {
    if (subscribed !== true) {
      return {subscribed, suppression: null};
    }

    const suppression = await this.find(projectId, address);
    if (suppression) {
      signale.info(
        `[SUPPRESSION] ${normalizeEmail(address)} stays unsubscribed: suppressed after a ${suppression.reason.toLowerCase()}`,
      );
      return {subscribed: false, suppression};
    }

    return {subscribed, suppression: null};
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
