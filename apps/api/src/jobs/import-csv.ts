/**
 * Reading an uploaded contacts CSV: parsing it, and splitting each row into what the import writes.
 */

import {parse} from 'csv-parse/sync';

import {unescapeCsvFormula} from '../utils/csv.js';

/**
 * Columns the contacts export writes for reading only. Importing them back would turn each into
 * a custom field, so they are skipped. `segments`, `status` and `createdAt` are not among them:
 * they are read apart (see `splitImportRecord`).
 */
const READ_ONLY_COLUMNS = new Set(['updatedat', 'dynamicsegments']);

/**
 * Parse an uploaded CSV. Headers are lowercased; a UTF-8 byte order mark (spreadsheets write
 * one, and so does the contacts export) is dropped so the first header still reads `email`.
 */
export function parseImportCsv(content: string): Record<string, string>[] {
  return parse(content, {
    bom: true,
    // Normalize headers to lowercase, undoing the export's formula escaping like any other cell
    columns: (header: string[]) => header.map(h => unescapeCsvFormula(h).toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true, // Allow rows with different column counts
  }) as Record<string, string>[];
}

/** One parsed CSV row, split into what the import writes. */
export interface ImportRecord {
  email: string;
  subscribed?: boolean;
  /** An exported snoozed row, unchanged: an existing contact's subscription should be left alone. */
  keepSnooze: boolean;
  data?: Record<string, string | boolean | number>;
  segments?: string;
  /** The `createdAt` cell, when it holds a usable date (see `parseImportDate`). */
  createdAt?: Date;
  /** The `createdAt` cell is filled but holds no usable date. */
  invalidCreatedAt: boolean;
  /** What the `status` cell says (see `importStatusSubscription`); read only without a `subscribed` cell. */
  statusSubscription?: boolean | 'notMailable';
  /**
   * A `status` the import does not know, lowercased; read only without a `subscribed` cell. Blank
   * (`''`) when only `status` speaks for the file and this row's is empty.
   */
  unknownStatus?: string;
}

/**
 * Split one parsed row into what the import writes: the email, what the row says about the
 * subscription, custom data, the sign-up date and the raw `segments` cell. Undoes the export's
 * formula escaping on every cell and skips the export's read-only columns, so an exported file
 * re-imports to the same contacts. `statusOnly` marks a file with a `status` column and no
 * `subscribed` one, where a row with no status is unknown rather than a reason to subscribe.
 */
export function splitImportRecord(
  record: Record<string, string>,
  {statusOnly = false}: {statusOnly?: boolean} = {},
): ImportRecord {
  const cells = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, unescapeCsvFormula(value)]));
  const {email, subscribed: subscribedValue, segments, status = '', createdat = '', ...rest} = cells;

  // Extract subscribed field if present (case-insensitive)
  let subscribed: boolean | undefined;
  if (subscribedValue !== undefined && subscribedValue !== '') {
    const lowerValue = subscribedValue.toLowerCase().trim();
    subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';
  }
  const statusValue = status.trim().toLowerCase();
  // The export writes snoozed contacts as subscribed=false; importing that back would turn the
  // snooze into a permanent opt-out, so an unchanged snoozed row is flagged for the worker.
  const keepSnooze = subscribed === false && statusValue === 'snoozed';

  // Without a `subscribed` cell, `status` speaks for the subscription: it is all Flodesk exports.
  let statusSubscription: boolean | 'notMailable' | undefined;
  let unknownStatus: string | undefined;
  if (subscribed === undefined && (statusValue !== '' || statusOnly)) {
    statusSubscription = importStatusSubscription(statusValue);
    if (statusSubscription === undefined) {
      unknownStatus = statusValue;
    }
  }

  const createdAt = createdat.trim() === '' ? undefined : parseImportDate(createdat);

  // Custom data: every other column except the read-only ones
  const data = importCustomData(
    Object.fromEntries(Object.entries(rest).filter(([key]) => !READ_ONLY_COLUMNS.has(key))),
  );

  return {
    email: email?.trim() ?? '',
    subscribed,
    keepSnooze,
    data,
    segments,
    createdAt: createdAt ?? undefined,
    invalidCreatedAt: createdAt === null,
    statusSubscription,
    unknownStatus,
  };
}

/**
 * The subscription an imported row writes, or `undefined` to leave it alone (a new contact is
 * then created subscribed). A `subscribed` cell decides. Without one, `status` decides and fails
 * closed: a new contact is subscribed only by a status that says so (a snooze cannot carry over,
 * and an unknown status is reported), and an existing contact is only ever unsubscribed by it,
 * on an opt-out, never resubscribed.
 */
export function importedSubscription(row: ImportRecord, isUpdate: boolean): boolean | undefined {
  if (row.subscribed !== undefined) {
    // An unchanged snoozed row keeps an existing contact's snooze; a contact new to this project
    // cannot carry the snooze over, so it arrives unsubscribed rather than mailable.
    return row.keepSnooze && isUpdate ? undefined : row.subscribed;
  }
  if (row.statusSubscription === undefined && row.unknownStatus === undefined) {
    return undefined;
  }
  if (isUpdate) {
    return row.statusSubscription === false ? false : undefined;
  }
  return row.statusSubscription === true;
}

// Statuses of Plunk's export and of other providers' (Flodesk, Mailchimp, ...), lowercased
const STATUS_SUBSCRIBED = new Set(['subscribed', 'confirmed', 'active']);
// The person's own decision to stop receiving email
const STATUS_OPTED_OUT = new Set(['unsubscribed', 'complained']);
// Not mailable at the source, but not the person's decision: a snooze, a bounce, a list cleanup
const STATUS_NOT_MAILABLE = new Set([
  'snoozed',
  'bounced',
  'cleaned',
  'inactive',
  'unconfirmed',
  'pending',
  'cancelled',
]);

/**
 * What a `status` cell says about the subscription: `true` to subscribe, `false` for an opt-out,
 * `'notMailable'` for a status that is neither (new contacts arrive unsubscribed, existing ones
 * are left as they are), or `undefined` for a status this map does not know. Case-insensitive.
 */
export function importStatusSubscription(value: string): boolean | 'notMailable' | undefined {
  const status = value.trim().toLowerCase();
  if (STATUS_SUBSCRIBED.has(status)) return true;
  if (STATUS_OPTED_OUT.has(status)) return false;
  if (STATUS_NOT_MAILABLE.has(status)) return 'notMailable';
  return undefined;
}

// `2024-03-04`, or a date and time after `T` or a space, with optional seconds, fraction and zone
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;
const EARLIEST_CREATED_AT = Date.UTC(1990, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read a `createdAt` cell as an ISO 8601 date: a date alone is midnight UTC, and a date and time
 * without a zone is UTC too. Returns `null` for anything else, for dates that do not exist
 * (`2026-02-30`, `T24:00`), and for dates before 1990 or more than a day ahead; one less than a
 * day ahead (a clock or zone slip) is taken as `now`.
 */
export function parseImportDate(value: string, now = new Date()): Date | null {
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0', zone = 'Z'] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Milliseconds: a longer fraction (Postgres and Python write microseconds) is cut to three digits
  const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3));
  const wallClock = new Date(Date.UTC(y, mo - 1, d, h, mi, s, milliseconds));
  // Date.UTC rolls an impossible date over (February 30 into March, 24:00 into the next day) and
  // maps years below 100 to the 1900s: whatever no longer reads as written did not exist.
  const asWritten =
    wallClock.getUTCFullYear() === y &&
    wallClock.getUTCMonth() === mo - 1 &&
    wallClock.getUTCDate() === d &&
    wallClock.getUTCHours() === h &&
    wallClock.getUTCMinutes() === mi &&
    wallClock.getUTCSeconds() === s;
  if (!asWritten) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    // No zone is further than 14 hours from UTC
    if (zoneMinutes > 59 || zoneHours * 60 + zoneMinutes > 14 * 60) {
      return null;
    }
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
  }

  const time = wallClock.getTime() - offsetMinutes * 60 * 1000;
  if (time < EARLIEST_CREATED_AT || time > now.getTime() + DAY_MS) {
    return null;
  }
  return new Date(Math.min(time, now.getTime()));
}

/**
 * The custom field a CSV column fills. Segment filters, workflow conditions and templates read a
 * dot in a field name as nesting, so `metafields.lastOpen` is stored as `metafields_lastopen`
 * rather than as a key none of them can reach. A leading `data.` names the field itself:
 * `data.plan` fills `plan`, and the export's `data.Status` (a field named like a fixed column)
 * comes back as the field `status` rather than as the subscription status.
 *
 * @param column The column name, already lowercased.
 * @returns The field name to store the value under.
 */
export function importFieldKey(column: string): string {
  return column.replace(/^data\.(?=.)/, '').replace(/\./g, '_');
}

/**
 * The custom data a row's other columns fill, or `undefined` when there are none. Two columns can
 * fill one field (`plan` and `data.plan`): an empty cell never erases the other's value.
 *
 * @param columns The row's cells by lowercased column name, without the reserved ones.
 * @returns The fields to merge into the contact's data.
 */
export function importCustomData(
  columns: Record<string, string>,
): Record<string, string | boolean | number> | undefined {
  const fields = new Map<string, string | boolean | number>();
  for (const [column, value] of Object.entries(columns)) {
    const field = importFieldKey(column);
    if (value.trim() === '' && fields.has(field)) continue;
    fields.set(field, coerceCustomValue(value));
  }
  return fields.size > 0 ? Object.fromEntries(fields) : undefined;
}

// Values considered as boolean during import.
// Numbers (0, 1) are intentionally absent.
const BOOLEAN_TRUE = new Set(['true', 'yes']);
const BOOLEAN_FALSE = new Set(['false', 'no']);

// Strict integer-or-decimal number detection pattern.
// Valid: 0, 42, -42, 3.14
// Rejected: 007, +42, 1.2.3, 1e5
const NUMERIC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Coerces a raw string into its most natural primitive type: `boolean`,
 * `number`, or `string`. Values that match neither are
 * returned unchanged.
 *
 * @param value The raw string to coerce.
 * @returns The coerced value as `boolean`, `number`, or `string`.
 */
export function coerceCustomValue(value: string): string | boolean | number {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (BOOLEAN_TRUE.has(lower)) return true;
  if (BOOLEAN_FALSE.has(lower)) return false;
  if (NUMERIC_RE.test(trimmed)) return Number(trimmed);
  return value;
}
