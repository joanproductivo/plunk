/**
 * Event tracking job data types
 */

/**
 * Job data for tracking an SES event (delivery, open, click, bounce, complaint) outside the
 * webhook request that received it, so the workflows it starts or resumes run in the worker.
 * Plunk Lite: also the `contact.unsubscribed` a bounce or complaint causes, after its event or,
 * for a bounce of no stored email, on its own.
 * Used by: eventTrackingQueue worker
 */
export interface EventTrackingJobData {
  projectId: string;
  eventName: string;
  contactId: string;
  /** The email the event is about. Absent for an unsubscribe a bounce of no stored email caused */
  emailId?: string;
  data: Record<string, unknown>;
  /**
   * Plunk Lite: an event tracked right after this one, for the same contact and email -- the
   * `contact.unsubscribed` a bounce or complaint causes, which must reach workflows after it
   */
  followUp?: {eventName: string; data: Record<string, unknown>};
}
