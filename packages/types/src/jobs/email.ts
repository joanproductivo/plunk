/**
 * Email queue job data types
 */

/**
 * Job data for sending a single email
 * Used by: emailQueue worker
 */
export interface SendEmailJobData {
  emailId: string;
  /**
   * Set once SES has accepted the email, before the send is recorded. A retry that finds it
   * only records the send: SES already has the message, so it must not be given it again.
   */
  accepted?: AcceptedEmail;
  /** How many times the recovery sweep has given an accepted email's failed job another round */
  sweepRetries?: number;
  /**
   * Plunk Lite: how many times SES's sending rate has put this email back without spending an
   * attempt, and since when (ms) a daily quota or an account pause has held it back
   */
  rateLimitedStarts?: number;
  heldSince?: number;
}

/** What SES returned for an accepted email, and the subject it went out with */
export interface AcceptedEmail {
  messageId: string;
  subject: string;
}

/**
 * Job data for recording a Stripe meter event
 * Used by: meterQueue worker
 */
export interface MeterEventJobData {
  customerId: string;
  value: number;
  idempotencyKey?: string;
}
