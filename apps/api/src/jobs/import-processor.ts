/**
 * Background Job: Contact Import Processor
 * Processes CSV contact imports with validation and batch processing
 */

import type {ContactImportJobData, ContactImportResult} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import {parse} from 'csv-parse/sync';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ContactService} from '../services/ContactService.js';
import {type ImportedRow, ImportSegmentResolver} from '../services/ImportSegmentResolver.js';
import {NtfyService} from '../services/NtfyService.js';
import {importQueue} from '../services/QueueService.js';
import {unescapeCsvFormula} from '../utils/csv.js';

const BATCH_SIZE = 100; // Process contacts in batches of 100

/**
 * Columns the contacts export writes for reading only. Importing them back would turn each into
 * a custom field, so they are skipped. `segments` is not among them: it assigns static segments.
 */
const READ_ONLY_COLUMNS = new Set(['status', 'createdat', 'updatedat', 'dynamicsegments']);

export function createImportWorker() {
  const worker = new Worker<ContactImportJobData>(
    importQueue.name,
    async (job: Job<ContactImportJobData>) => {
      const {projectId, csvData, filename} = job.data;

      signale.info(`[IMPORT-PROCESSOR] Processing import for project ${projectId} (${filename})`);

      // Fetch project information for notifications
      const project = await prisma.project.findUnique({
        where: {id: projectId},
        select: {name: true},
      });

      const projectName = project?.name || projectId;

      const result: ContactImportResult = {
        totalRows: 0,
        successCount: 0,
        createdCount: 0,
        updatedCount: 0,
        failureCount: 0,
        errors: [],
        segmentsCreated: [],
        segmentAssignments: 0,
      };

      try {
        // Decode base64 CSV data
        const csvContent = Buffer.from(csvData, 'base64').toString('utf-8');

        const records = parseImportCsv(csvContent);

        result.totalRows = records.length;

        // Validate row count
        if (records.length === 0) {
          throw new Error('CSV file is empty');
        }

        signale.info(`[IMPORT-PROCESSOR] Parsed ${records.length} rows from CSV`);

        // Notify that import has started
        await NtfyService.notifyContactImportStarted(projectName, projectId, filename, result.totalRows);

        // Validate that 'email' column exists (case-insensitive)
        const firstRecord = records[0];
        if (firstRecord && typeof firstRecord === 'object' && !('email' in firstRecord)) {
          throw new Error('CSV must have an "email" column (case-insensitive)');
        }

        const segments = await ImportSegmentResolver.load(projectId);

        // Process contacts in batches
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, Math.min(i + BATCH_SIZE, records.length));
          const imported: ImportedRow[] = [];

          // Process batch sequentially (to avoid overwhelming the database)
          for (const [batchIndex, record] of batch.entries()) {
            const rowNumber = i + batchIndex + 2; // +2 for header row and 1-based index

            try {
              const {email, subscribed, keepSnooze, data, segments: segmentCell} = splitImportRecord(record);

              // Validate email
              if (!email) {
                result.failureCount++;
                result.errors.push({
                  row: rowNumber,
                  email: '',
                  error: 'Email is required',
                });
                continue;
              }

              // Basic email validation
              if (!isValidEmail(email)) {
                result.failureCount++;
                result.errors.push({
                  row: rowNumber,
                  email,
                  error: 'Invalid email format',
                });
                continue;
              }

              // Check if contact exists before upserting
              const existingContact = await ContactService.findByEmail(projectId, email);
              const isUpdate = !!existingContact;

              // Upsert contact with subscribed value from CSV if provided
              // For new contacts, ContactService.upsert defaults to true
              // For existing contacts, only update if explicitly provided in CSV
              // An unchanged snoozed row keeps an existing contact's snooze; a contact new to this
              // project cannot carry the snooze over, so it arrives unsubscribed rather than mailable.
              const contact = await ContactService.upsert(
                projectId,
                email,
                data,
                keepSnooze && isUpdate ? undefined : subscribed,
              );
              imported.push({contactId: contact.id, segments: segmentCell});

              result.successCount++;
              if (isUpdate) {
                result.updatedCount++;
              } else {
                result.createdCount++;
              }
            } catch (error) {
              result.failureCount++;
              result.errors.push({
                row: rowNumber,
                email: record.email || '',
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          await segments.assignBatch(imported);

          // Update progress
          const progress = Math.round(((i + batch.length) / records.length) * 100);
          await job.updateProgress(progress);
        }

        const segmentsCreated = segments.segmentsCreated;
        result.segmentsCreated = segmentsCreated;
        result.segmentAssignments = segments.segmentAssignments;
        // Segment problems go first: there is one per name, and the dashboard lists only the first few errors.
        result.errors.unshift(...segments.errors);
        if (segmentsCreated.length > 0) {
          signale.info(`[IMPORT-PROCESSOR] Created static segments: ${segmentsCreated.join(', ')}`);
        }

        signale.info(
          `[IMPORT-PROCESSOR] Import completed: ${result.createdCount} created, ${result.updatedCount} updated, ${result.failureCount} failed`,
        );

        // Notify that import has completed
        await NtfyService.notifyContactImportCompleted(
          projectName,
          projectId,
          filename,
          result.successCount,
          result.createdCount,
          result.updatedCount,
          result.failureCount,
        );

        return result;
      } catch (error) {
        signale.error(`[IMPORT-PROCESSOR] Failed to process import:`, error);

        // Notify that import has failed
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await NtfyService.notifyContactImportFailed(projectName, projectId, filename, errorMessage);

        // Return partial results with error
        result.errors.push({
          row: 0,
          email: '',
          error: errorMessage,
        });

        throw error; // Re-throw to mark job as failed
      }
    },
    {
      connection: importQueue.opts.connection,
      concurrency: 2, // Process max 2 imports concurrently
    },
  );

  worker.on('completed', job => {
    signale.info(`[IMPORT-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[IMPORT-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[IMPORT-PROCESSOR] Worker error:', err);
  });

  return worker;
}

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

/**
 * Split one parsed row into what the import writes: the email, the subscription decision, custom
 * data, and the raw `segments` cell. Undoes the export's formula escaping on every cell and skips
 * the export's read-only columns, so an exported file re-imports to the same contacts.
 */
export function splitImportRecord(record: Record<string, string>): {
  email: string;
  subscribed?: boolean;
  /** An exported snoozed row, unchanged: an existing contact's subscription should be left alone. */
  keepSnooze: boolean;
  data?: Record<string, string | boolean | number>;
  segments?: string;
} {
  const cells = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, unescapeCsvFormula(value)]));
  const {email, subscribed: subscribedValue, segments, ...rest} = cells;

  // Extract subscribed field if present (case-insensitive)
  let subscribed: boolean | undefined;
  if (subscribedValue !== undefined && subscribedValue !== '') {
    const lowerValue = subscribedValue.toLowerCase().trim();
    subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';
  }
  // The export writes snoozed contacts as subscribed=false; importing that back would turn the
  // snooze into a permanent opt-out, so an unchanged snoozed row is flagged for the worker.
  const keepSnooze = subscribed === false && rest.status?.trim().toLowerCase() === 'snoozed';

  // Custom data: every other column except the read-only ones
  const customEntries = Object.entries(rest).filter(([key]) => !READ_ONLY_COLUMNS.has(key));
  const data =
    customEntries.length > 0 ? Object.fromEntries(customEntries.map(([k, v]) => [k, coerceCustomValue(v)])) : undefined;

  return {email: email?.trim() ?? '', subscribed, keepSnooze, data, segments};
}

/**
 * Basic email validation
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
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
