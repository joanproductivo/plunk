import {Prisma} from '@plunk/db';

/**
 * Plunk Lite: database helpers its services share.
 */

/**
 * A transaction that deletes or unlinks many rows at once -- every email of many contacts, of a big
 * workflow, a batch of segments -- and can outlast Prisma's 5 s default
 */
export const LONG_TRANSACTION = {timeout: 60_000, maxWait: 10_000};

/**
 * A transaction of the SES webhook: a burst of events can queue for a connection, and Prisma's
 * default two-second wait would answer 500 and lean on SNS's retries
 */
export const SES_EVENT_TRANSACTION = {maxWait: 10_000, timeout: 10_000};

/**
 * A short transaction that must not fail on a pool spike: maxWait as long as a lone query may wait
 * for a pooled connection (the pool_timeout a deployment sets on DATABASE_URL), where Prisma's 2 s
 * default would fail it on every short spike
 */
export const POOL_WAIT_TRANSACTION = {maxWait: 20_000};

/** A date as the UTC timestamps without time zone the tables hold, for a raw query */
export const utcTimestamp = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
