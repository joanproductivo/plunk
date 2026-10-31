import type {Segment} from '@plunk/db';

/** A segment's name by id: '…' while the segments load, 'Deleted segment' when it is gone */
export function segmentName(segments: Pick<Segment, 'id' | 'name'>[] | undefined, id: string): string {
  return segments ? (segments.find(segment => segment.id === id)?.name ?? 'Deleted segment') : '…';
}
