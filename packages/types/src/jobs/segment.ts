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
  projectId: string;
  segmentId: string;
  /** Name when the change was made, so the events keep the slug they were made under */
  segmentName: string;
  kind: SegmentEventKind;
  contactIds: string[];
}
