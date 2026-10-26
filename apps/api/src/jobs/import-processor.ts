/**
 * Background Job: Contact Import Processor
 * Processes CSV contact imports with validation and batch processing
 */

import type {ContactImportJobData, ContactImportResult} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ContactService} from '../services/ContactService.js';
import {type ImportedRow, ImportSegmentResolver} from '../services/ImportSegmentResolver.js';
import {NtfyService} from '../services/NtfyService.js';
import {importQueue} from '../services/QueueService.js';

import {importedSubscription, parseImportCsv, splitImportRecord} from './import-csv.js';

const BATCH_SIZE = 100; // Process contacts in batches of 100

/** Most distinct unknown `status` values an import reports one by one. */
const MAX_UNKNOWN_STATUS_WARNINGS = 10;

/**
 * Import one uploaded CSV into a project. Exported so tests can run it without a queue.
 */
export async function processContactImport(job: Job<ContactImportJobData>): Promise<ContactImportResult> {
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
    warnings: [],
    segmentsCreated: [],
    segmentAssignments: 0,
  };
  // Rows behind each warning, reported once the import is done
  let invalidCreatedAtRows = 0;
  const unknownStatusRows = new Map<string, number>();
  let otherUnknownStatusRows = 0;

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

    // The file's columns, from every row: a short row has no key for the cells it lacks
    const columns = new Set<string>();
    for (const record of records) {
      Object.keys(record).forEach(column => columns.add(column));
    }
    // Only Plunk's export writes `dynamicSegments`; its cells separate segments by `;` alone
    const segments = await ImportSegmentResolver.load(projectId, {commaSeparated: !columns.has('dynamicsegments')});
    const statusOnly = columns.has('status') && !columns.has('subscribed');

    // Process contacts in batches
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, Math.min(i + BATCH_SIZE, records.length));
      const imported: ImportedRow[] = [];

      // Process batch sequentially (to avoid overwhelming the database)
      for (const [batchIndex, record] of batch.entries()) {
        const rowNumber = i + batchIndex + 2; // +2 for header row and 1-based index

        try {
          const row = splitImportRecord(record, {statusOnly});
          const {email} = row;

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

          // upsert gets both decisions and applies the one that fits the contact when it writes it,
          // so a contact created meanwhile (another import, the API) is treated as existing. With
          // neither column, a new contact is created subscribed. upsert only dates a contact it
          // creates: an existing one keeps its date.
          const contact = await ContactService.upsert(
            projectId,
            email,
            row.data,
            importedSubscription(row, true),
            importedSubscription(row, false) ?? true,
            {createdAt: row.createdAt},
          );
          imported.push({contactId: contact.id, segments: row.segments});

          if (row.invalidCreatedAt && !isUpdate) {
            invalidCreatedAtRows++;
          }
          if (row.unknownStatus !== undefined) {
            const status = row.unknownStatus;
            if (unknownStatusRows.has(status) || unknownStatusRows.size < MAX_UNKNOWN_STATUS_WARNINGS) {
              unknownStatusRows.set(status, (unknownStatusRows.get(status) ?? 0) + 1);
            } else {
              otherUnknownStatusRows++;
            }
          }

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
    result.warnings = importWarnings(invalidCreatedAtRows, unknownStatusRows, otherUnknownStatusRows);
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
}

export function createImportWorker() {
  const worker = new Worker<ContactImportJobData>(importQueue.name, processContactImport, {
    connection: importQueue.opts.connection,
    concurrency: 2, // Process max 2 imports concurrently
  });

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

/** Rows imported, but not quite as the file said; reported apart from the errors. */
function importWarnings(
  invalidCreatedAtRows: number,
  unknownStatusRows: Map<string, number>,
  otherUnknownStatusRows: number,
): string[] {
  const rows = (count: number) => `${count} row${count === 1 ? '' : 's'}`;
  const warnings: string[] = [];
  if (invalidCreatedAtRows > 0) {
    warnings.push(
      `createdAt is not an ISO 8601 date from 1990 to a day ahead in ${rows(invalidCreatedAtRows)}: those new contacts were dated today`,
    );
  }
  for (const [status, count] of unknownStatusRows) {
    const characters = Array.from(status);
    const shown = characters.length > 40 ? `${characters.slice(0, 40).join('')}…` : status;
    warnings.push(
      `${status === '' ? 'No status' : `Unknown status "${shown}"`} in ${rows(count)}: new contacts were imported unsubscribed, existing ones left as they were`,
    );
  }
  if (otherUnknownStatusRows > 0) {
    warnings.push(`Other unknown statuses in ${rows(otherUnknownStatusRows)}, handled the same way`);
  }
  return warnings;
}

/**
 * Basic email validation
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
