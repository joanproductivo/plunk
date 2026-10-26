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

export type SegmentEventKind = 'entry' | 'exit';

/** Most emails one call to the static segment members endpoints takes */
export const SEGMENT_MEMBERS_MAX = 500;

/**
 * Name of the event fired when a contact enters or leaves a segment that tracks membership.
 * Example: ("VIP Customers", "entry") -> "segment.vip-customers.entry"
 */
export function segmentEventName(segmentName: string, kind: SegmentEventKind): string {
  return `segment.${slugifySegmentName(segmentName)}.${kind}`;
}
