/**
 * Import and bulk operation queue job data types
 */

import type {ContactSubscriptionStatus} from '../api/contact.js';

/**
 * Job data for importing contacts from CSV
 * Used by: importQueue worker
 */
export interface ContactImportJobData {
  projectId: string;
  csvData: string; // Base64 encoded CSV content
  filename: string;
}

/**
 * Outcome of a CSV import job, returned by `GET /contacts/import/:jobId` once it completes.
 */
export interface ContactImportResult {
  totalRows: number;
  successCount: number;
  createdCount: number;
  updatedCount: number;
  failureCount: number;
  /**
   * Row-level failures, plus one entry per segment name that could not be assigned. Segment
   * entries use `row: SEGMENT_IMPORT_ERROR_ROW` and an empty `email`.
   */
  errors: {row: number; email: string; error: string}[];
  /**
   * Rows that were imported, but not quite as the file said: a `createdAt` that is not a usable
   * date, or a `status` the import does not know. They do not count as failures. Optional only
   * because jobs that finished before warnings existed have no such field.
   */
  warnings?: string[];
  /**
   * Static segments the import created because the `segments` column named them. Optional only
   * because jobs that finished before segment assignment existed have no such field.
   */
  segmentsCreated?: string[];
  /** Contacts newly added (or re-added) to a static segment; members already in it are not counted. */
  segmentAssignments?: number;
}

/** Row number of segment errors in an import result; CSV data rows start at 2. */
export const SEGMENT_IMPORT_ERROR_ROW = 0;

/**
 * The contacts list filters. `status` is the current facet; `subscribed` is the legacy boolean,
 * kept for API callers that predate snoozing and ignored when `status` is set. `segmentId` keeps
 * the segment's current stored members: every member of a static segment, while a dynamic
 * segment only stores them when it tracks membership, and they lag its rules.
 */
export interface ContactListFilter {
  search?: string;
  status?: ContactSubscriptionStatus;
  subscribed?: boolean;
  segmentId?: string;
}

/**
 * Selector describing which contacts a bulk action should target.
 * - `ids`: explicit list, hard-capped at 1000.
 * - `query`: every contact matching the filter, optionally excluding specific ids.
 *   Snapshot semantics: the worker iterates current matches at execution time, so
 *   contacts created after the job is queued may or may not be included.
 */
export type BulkContactActionSelector =
  | {mode: 'ids'; contactIds: string[]}
  | {
      mode: 'query';
      /** Mirrors the contacts list filters. */
      filter: ContactListFilter;
      excludeIds?: string[];
    };

/** Bulk operations that add contacts to, or remove them from, a static segment */
export const BULK_SEGMENT_OPERATIONS = ['addToSegment', 'removeFromSegment'] as const;
export type BulkSegmentOperation = (typeof BULK_SEGMENT_OPERATIONS)[number];

/** Bulk operations on the contacts themselves */
export type BulkContactRecordOperation = 'subscribe' | 'unsubscribe' | 'delete';

export type BulkContactOperation = BulkContactRecordOperation | BulkSegmentOperation;

export function isBulkSegmentOperation(operation: BulkContactOperation | null): operation is BulkSegmentOperation {
  return (BULK_SEGMENT_OPERATIONS as readonly string[]).includes(operation ?? '');
}

/**
 * Outcome of a bulk contact job, returned by `GET /contacts/bulk/:jobId` once it completes.
 */
export interface BulkContactActionResult {
  operation: BulkContactOperation;
  totalRequested: number;
  /** Contacts whose state was actually changed by this run. */
  successCount: number;
  /** Contacts already in the target state (already subscribed, not in the segment, ...). */
  unchangedCount: number;
  /** Contacts that errored or weren't found (e.g. wrong project). */
  failureCount: number;
  errors: {contactId: string; email: string; error: string}[];
}

/**
 * Where a segment job got to, saved after each batch. Adding a contact who is already in the
 * segment counts as a new entry, so a retried job carries on from here instead of starting over
 * and firing those entries again.
 */
export interface BulkContactActionResume {
  /** ids mode: index of the next contact. query mode: the last contact id handled. */
  next: number | string;
  processed: number;
  result: BulkContactActionResult;
}

export interface BulkContactActionJobBase {
  projectId: string;
  selector: BulkContactActionSelector;
}

/**
 * Job data for bulk contact actions
 * Used by: bulkContactQueue worker
 */
export type BulkContactActionJobData =
  | (BulkContactActionJobBase & {operation: BulkContactRecordOperation})
  | (BulkContactActionJobBase & {
      operation: BulkSegmentOperation;
      targetSegmentId: string;
      resume?: BulkContactActionResume;
    });
