/**
 * Event tracking job data types
 */

/**
 * Job data for tracking an SES event (delivery, open, click, bounce, complaint) outside the
 * webhook request that received it, so the workflows it starts or resumes run in the worker
 * Used by: eventTrackingQueue worker
 */
export interface EventTrackingJobData {
  projectId: string;
  eventName: string;
  contactId: string;
  emailId: string;
  data: Record<string, unknown>;
}
