import {Prisma} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {utcTimestamp} from '../utils/database.js';

/**
 * Plunk Lite: what a project's reputation rates count, including the emails that are gone.
 *
 * Deleting a contact deletes its emails, and AWS keeps counting their bounces and complaints. If
 * the rates lost them, deleting the contacts that bounced would put a project's own rates back in
 * the green while its AWS account is still in trouble. So each delete of emails adds the ones the
 * rates count to `plunk_lite_deleted_email_counts`, by the minute they were created in, and a
 * project's rates add those up (ReputationPolicy.rates). The brakes of a campaign or a workflow do
 * not: a deleted email no longer says which one sent it.
 *
 * The column that holds the minute is still called "hour": counts were kept by the hour at first,
 * and their rows stay valid as the minute :00. Renaming it would break the image before this one,
 * which is what a rollback deploys.
 */

/**
 * The emails a rate counts, of `emails` as `e`: the ones given to SES, as only those count for
 * AWS, and not to its mailbox simulator, which AWS leaves out of its own rates. The one definition,
 * shared by the rates and the counts of deleted emails.
 */
export const RATED_EMAIL = Prisma.sql`e."simulated" = false AND e."sentAt" IS NOT NULL`;

/** How many of them, how many bounced and how many were reported as spam: three int columns */
export const RATE_COUNTS = Prisma.sql`count(*)::int,
  (count(*) FILTER (WHERE e."bouncedAt" IS NOT NULL))::int,
  (count(*) FILTER (WHERE e."complainedAt" IS NOT NULL))::int`;

/** The deleted emails of a project counted in a minute, as `plunk_lite_deleted_email_counts` holds them */
export interface DeletedCounts {
  sent: number;
  bounced: number;
  complained: number;
}

export const DeletedEmailCounts = {
  /**
   * Deletes a project's emails, all of them or those of some contacts, and counts the ones the
   * rates count, in one statement: an email sent, bounced or complained about while the delete
   * waits for its row is counted as it ends up. Called in the transaction that deletes the
   * contacts, before deleting them, so that their cascade finds no email left.
   */
  async deleteEmails(tx: Prisma.TransactionClient, projectId: string, contactIds?: string[]): Promise<void> {
    await tx.$executeRaw`
      WITH e AS (
        DELETE FROM "emails"
        WHERE "projectId" = ${projectId}
          ${contactIds ? Prisma.sql`AND "contactId" = ANY(${contactIds}::text[])` : Prisma.empty}
        RETURNING "projectId", "createdAt", "sentAt", "simulated", "bouncedAt", "complainedAt"
      )
      INSERT INTO "plunk_lite_deleted_email_counts" AS d ("projectId", "hour", "sent", "bounced", "complained")
      SELECT e."projectId", date_trunc('minute', e."createdAt"), ${RATE_COUNTS}
      FROM e
      WHERE ${RATED_EMAIL}
      GROUP BY 1, 2
      ON CONFLICT ("projectId", "hour") DO UPDATE SET
        "sent" = d."sent" + EXCLUDED."sent",
        "bounced" = d."bounced" + EXCLUDED."bounced",
        "complained" = d."complained" + EXCLUDED."complained"`;
  },

  /**
   * The deleted emails of a project a rate adds, created since a date or ever, as a subquery of
   * three int columns like RATE_COUNTS. They are counted by the minute, so the minute `since` falls
   * in counts whole: up to a minute more than the window, never less.
   *
   * `alreadyInFirstMinute` takes out of that minute what it held when the window started, each
   * column down to zero at most: for a window that starts at a reactivation, so that the bounces
   * deleted before it in the same minute do not count again, and the ones deleted after it still do.
   */
  sums(projectId: string, since?: Date, alreadyInFirstMinute?: DeletedCounts): Prisma.Sql {
    const first = since ? Prisma.sql`date_trunc('minute', ${utcTimestamp(since)})` : undefined;
    const column = (name: 'sent' | 'bounced' | 'complained') =>
      first && alreadyInFirstMinute
        ? Prisma.sql`coalesce(sum(greatest(d.${Prisma.raw(`"${name}"`)} - CASE WHEN d."hour" = ${first} THEN ${alreadyInFirstMinute[name]}::int ELSE 0 END, 0)), 0)::int`
        : Prisma.sql`coalesce(sum(d.${Prisma.raw(`"${name}"`)}), 0)::int`;
    return Prisma.sql`(
      SELECT ${column('sent')}, ${column('bounced')}, ${column('complained')}
      FROM "plunk_lite_deleted_email_counts" d
      WHERE d."projectId" = ${projectId}
        ${first ? Prisma.sql`AND d."hour" >= ${first}` : Prisma.empty}
    )`;
  },

  /** What the counts of a project hold for the minute a date falls in; zeros when nothing */
  async inMinute(projectId: string, date: Date): Promise<DeletedCounts> {
    const [row] = await prisma.$queryRaw<DeletedCounts[]>`
      SELECT d."sent", d."bounced", d."complained"
      FROM "plunk_lite_deleted_email_counts" d
      WHERE d."projectId" = ${projectId} AND d."hour" = date_trunc('minute', ${utcTimestamp(date)})`;
    return row ?? {sent: 0, bounced: 0, complained: 0};
  },
};
