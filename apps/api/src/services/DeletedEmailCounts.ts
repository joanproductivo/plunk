import {Prisma} from '@plunk/db';

/**
 * Plunk Lite: what a project's reputation rates count, including the emails that are gone.
 *
 * Deleting a contact deletes its emails, and AWS keeps counting their bounces and complaints. If
 * the rates lost them, deleting the contacts that bounced would put a project's own rates back in
 * the green while its AWS account is still in trouble. So each delete of emails adds the ones the
 * rates count to `plunk_lite_deleted_email_counts`, by the hour they were created in, and a
 * project's rates add those up (ReputationPolicy.rates). The brakes of a campaign or a workflow do
 * not: a deleted email no longer says which one sent it.
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

/** A date as the UTC timestamps without time zone the tables hold */
export const utcTimestamp = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Deleting every email of many contacts can outlast Prisma's 5 s default */
export const EMAIL_DELETE_TRANSACTION = {timeout: 60_000, maxWait: 10_000};

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
      SELECT e."projectId", date_trunc('hour', e."createdAt"), ${RATE_COUNTS}
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
   * three int columns like RATE_COUNTS. They are counted by the hour, so the hour `since` falls in
   * counts whole: up to an hour more than the window, never less.
   */
  sums(projectId: string, since?: Date): Prisma.Sql {
    return Prisma.sql`(
      SELECT coalesce(sum(d."sent"), 0)::int, coalesce(sum(d."bounced"), 0)::int, coalesce(sum(d."complained"), 0)::int
      FROM "plunk_lite_deleted_email_counts" d
      WHERE d."projectId" = ${projectId}
        ${since ? Prisma.sql`AND d."hour" >= date_trunc('hour', ${utcTimestamp(since)})` : Prisma.empty}
    )`;
  },
};
