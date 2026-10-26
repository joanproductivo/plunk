/**
 * Workflow-specific type definitions
 */

/**
 * Recipient type for workflow email steps
 */
export enum EmailRecipientType {
  /** Send to the contact that triggered the workflow */
  CONTACT = 'CONTACT',
  /** Send to a custom email address */
  CUSTOM = 'CUSTOM',
}

/**
 * Configuration for email recipient in SEND_EMAIL workflow step
 */
export interface EmailRecipientConfig {
  /** Type of recipient */
  type: EmailRecipientType;
  /** Custom email address (required when type is CUSTOM) */
  customEmail?: string;
}

/**
 * Configuration for SEND_EMAIL workflow step
 */
export interface SendEmailStepConfig {
  /** Template ID to use for the email */
  templateId: string;
  /** Recipient configuration */
  recipient?: EmailRecipientConfig;
}

/**
 * A field a workflow condition can check, from `GET /workflows/fields`. `field` is what the
 * step's config stores; `label` is set when that is not readable on its own, e.g. a segment's
 * name for its `segment.<id>` field.
 */
export interface AvailableField {
  field: string;
  type: string;
  category: string;
  label?: string;
}

/** Static segments an UPDATE_CONTACT step removes the contact from and adds it to, by id */
export interface UpdateContactSegmentChanges {
  add: string[];
  remove: string[];
}

/** What an UPDATE_CONTACT step did to segments, recorded in its step execution output */
export interface SegmentChangesResult {
  segmentsAdded: string[];
  segmentsRemoved: string[];
  /** Segments that were missing, of another project or dynamic, and were left alone */
  skippedSegments: string[];
}
