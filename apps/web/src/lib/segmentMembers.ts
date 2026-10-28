import {SEGMENT_MEMBERS_MAX, SegmentSchemas} from '@plunk/shared';
import {network} from './network';

export interface AddSegmentMembersResult {
  added: number;
  created: number;
  notFound: string[];
}

/**
 * Add emails to a static segment, in as many requests as the endpoint's per-call limit needs. With
 * `createMissing`, the addresses without a contact get one, unsubscribed (Plunk Lite).
 */
export async function addSegmentMembers(
  segmentId: string,
  emails: string[],
  options: {createMissing?: boolean} = {},
): Promise<AddSegmentMembersResult> {
  const total: AddSegmentMembersResult = {added: 0, created: 0, notFound: []};

  for (let i = 0; i < emails.length; i += SEGMENT_MEMBERS_MAX) {
    const result = await network.fetch<AddSegmentMembersResult, typeof SegmentSchemas.members>(
      'POST',
      `/segments/${segmentId}/members`,
      {emails: emails.slice(i, i + SEGMENT_MEMBERS_MAX), ...options},
    );
    total.added += result.added;
    total.created += result.created;
    total.notFound.push(...result.notFound);
  }

  return total;
}
