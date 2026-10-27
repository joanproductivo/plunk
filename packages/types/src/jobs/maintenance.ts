/**
 * Maintenance and background task queue job data types
 */

/**
 * Job data for updating segment membership counts
 * Used by: segmentCountQueue worker
 */
export interface SegmentCountJobData {
  projectId?: string; // Optional: if provided, only update this project's segments
}

/**
 * Job data for domain verification checks
 * Used by: domainVerificationQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainVerificationJobData {
  // Empty for now - processes all domains
}

/**
 * Job data for cleaning up old API request logs
 * Used by: apiRequestCleanupQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ApiRequestCleanupJobData {
  // Empty - cleans up old API request logs
}

/**
 * Job data for cleaning up expired idempotency keys
 * Used by: idempotencyKeyCleanupQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IdempotencyKeyCleanupJobData {
  // Empty - cleans up all keys past their expiresAt
}

/**
 * Job data for clearing the rendered HTML body of old emails
 * Used by: emailBodyCleanupQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmailBodyCleanupJobData {
  // Empty - clears bodies for every email past the retention window
}

/**
 * Job data for recovering emails left PENDING without a job or stuck in SENDING
 * Used by: emailRecoverySweepQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmailRecoverySweepJobData {
  // Empty - sweeps the oldest stuck emails of every project
}

/**
 * Job data for resubscribing contacts whose snooze has run out
 * Used by: snoozeSweepQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SnoozeSweepJobData {
  // Empty - sweeps every contact whose snoozedUntil has passed
}

/**
 * Job data for the reputation check after a bounce or complaint (Plunk Lite). One job per project
 * is pending at a time; the events that arrive while it waits are collected in Redis, and this is
 * the one that queued it.
 * Used by: plunkLiteChecksQueue worker, job `security-check`
 */
export interface SecurityCheckJobData {
  projectId: string;
  trigger: 'bounce' | 'complaint';
  /** The campaign or workflow the email came from, `campaign:<id>` or `workflow:<id>` */
  source?: string;
}

/**
 * Job data of Plunk Lite's own checks
 * Used by: plunkLiteChecksQueue worker
 */
export type PlunkLiteChecksJobData = SecurityCheckJobData;
