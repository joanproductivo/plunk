import type {SegmentEventKind} from '@plunk/types';

/**
 * Convert segment name to a URL-safe slug for event names
 * Example: "VIP Customers" -> "vip-customers"
 */
export function slugifySegmentName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

/** Most emails one call to the static segment members endpoints takes */
export const SEGMENT_MEMBERS_MAX = 500;

/** Most segments one call to the segments bulk-update endpoint takes */
export const SEGMENTS_BULK_MAX = 1000;

/**
 * Name of the event fired when a contact enters or leaves a segment that tracks membership.
 * Example: ("VIP Customers", "entry") -> "segment.vip-customers.entry"
 */
export function segmentEventName(segmentName: string, kind: SegmentEventKind): string {
  return `segment.${slugifySegmentName(segmentName)}.${kind}`;
}

/** Plunk Lite: most static segments one /v1/track or /v1/send call adds its contacts to */
export const REQUEST_SEGMENTS_MAX = 20;

/** Most segments one Update contact workflow step adds to, and removes from, each */
export const WORKFLOW_SEGMENT_CHANGES_MAX = 20;
