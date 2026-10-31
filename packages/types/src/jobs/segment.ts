/**
 * Segment membership job data types
 */

/** Whether a segment membership event marks a contact joining or leaving */
export type SegmentEventKind = 'entry' | 'exit';

/**
 * Job data for firing a static segment's entry/exit events outside the request that changed it
 * Used by: segmentMembershipEventsQueue worker
 */
export interface SegmentMembershipEventsJobData {
  /** Absent on jobs queued before contact subscription events shared the queue (Plunk Lite) */
  type?: 'segment-membership';
  projectId: string;
  segmentId: string;
  /** Name when the change was made, so the events keep the slug they were made under */
  segmentName: string;
  kind: SegmentEventKind;
  contactIds: string[];
}

/**
 * Job data for the contact.subscribed / contact.unsubscribed events of a bulk subscription change
 * (Plunk Lite), fired in the same ordered queue as segment membership events
 * Used by: segmentMembershipEventsQueue worker
 */
export interface ContactSubscriptionEventsJobData {
  type: 'contact-subscription';
  projectId: string;
  eventName: 'contact.subscribed' | 'contact.unsubscribed';
  contactIds: string[];
}

/** What the segmentMembershipEventsQueue carries */
export type MembershipEventsJobData = SegmentMembershipEventsJobData | ContactSubscriptionEventsJobData;
