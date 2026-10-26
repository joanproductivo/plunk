import type {Prisma} from '@plunk/db';
import type {ContactSegments, FilterCondition, SegmentRef} from '@plunk/types';
import {fromPrismaJson} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {SegmentService} from './SegmentService.js';

/** A dynamic segment with its filter already built */
export interface DynamicSegment extends SegmentRef {
  where: Prisma.ContactWhereInput;
}

/**
 * Which segments contacts belong to, worked out for many contacts at once: one query for the
 * static memberships, and one per dynamic segment, never one per contact. Shared by the contacts
 * export and the contact page.
 */
export class ContactSegmentsService {
  /** One contact's static and dynamic segments. The caller checks the contact is the project's. */
  public static async forContact(projectId: string, contactId: string): Promise<ContactSegments> {
    // No probe: for a single contact a failing filter is just as well dropped by dynamicSegmentsOf,
    // and probing would scan the project once per segment on every view of a contact
    const dynamicSegments = await this.loadDynamicSegments(projectId, {probe: false});
    const staticSegments = await this.staticSegmentsOf(projectId, [contactId]);
    const dynamic = await this.dynamicSegmentsOf(projectId, [contactId], dynamicSegments);

    return {static: staticSegments.get(contactId) ?? [], dynamic: dynamic.get(contactId) ?? []};
  }

  /** Active static memberships of a batch of contacts, as sorted segments per contact. */
  public static async staticSegmentsOf(projectId: string, contactIds: string[]): Promise<Map<string, SegmentRef[]>> {
    const memberships = await prisma.segmentMembership.findMany({
      where: {contactId: {in: contactIds}, exitedAt: null, segment: {projectId, type: 'STATIC'}},
      select: {contactId: true, segment: {select: {id: true, name: true}}},
    });

    const segments = new Map<string, SegmentRef[]>();
    for (const {contactId, segment} of memberships) {
      segments.set(contactId, [...(segments.get(contactId) ?? []), segment]);
    }
    return sortByName(segments);
  }

  /**
   * The project's dynamic segments with their filters built once. Membership is evaluated live
   * from the filter -- the same rule the member counts use -- so it does not depend on whether
   * the segment tracks membership. A filter that cannot be built (a malformed condition, a
   * reference to a deleted segment) leaves that segment out rather than failing the caller.
   *
   * `probe` also runs each filter once, so one that builds but cannot run is left out up front:
   * the export uses it to settle its columns before writing anything.
   */
  public static async loadDynamicSegments(
    projectId: string,
    {probe = true}: {probe?: boolean} = {},
  ): Promise<DynamicSegment[]> {
    const segments = await prisma.segment.findMany({
      where: {projectId, type: 'DYNAMIC'},
      select: {id: true, name: true, condition: true},
    });

    const usable: DynamicSegment[] = [];
    for (const segment of segments) {
      try {
        const condition = fromPrismaJson<FilterCondition>(segment.condition);
        const where = await SegmentService.buildConditionClause(condition);
        if (probe) {
          await prisma.contact.findFirst({where: {AND: [{projectId}, where]}, select: {id: true}});
        }
        usable.push({id: segment.id, name: segment.name, where});
      } catch (error) {
        signale.warn(`[CONTACT-SEGMENTS] Leaving out dynamic segment ${segment.id}:`, error);
      }
    }
    return usable;
  }

  /**
   * The dynamic segments each contact of a batch matches, sorted per contact. A segment whose
   * filter fails is removed from `segments`, so later batches of the same caller skip it too.
   */
  public static async dynamicSegmentsOf(
    projectId: string,
    contactIds: string[],
    segments: DynamicSegment[],
  ): Promise<Map<string, SegmentRef[]>> {
    const matches = new Map<string, SegmentRef[]>();

    // Iterate over a copy, since a failing segment is spliced out of the caller's list.
    for (const segment of [...segments]) {
      try {
        const members = await prisma.contact.findMany({
          where: {AND: [{projectId}, segment.where, {id: {in: contactIds}}]},
          select: {id: true},
        });
        for (const member of members) {
          matches.set(member.id, [...(matches.get(member.id) ?? []), {id: segment.id, name: segment.name}]);
        }
      } catch (error) {
        signale.warn(`[CONTACT-SEGMENTS] Dropping dynamic segment ${segment.id}:`, error);
        segments.splice(segments.indexOf(segment), 1);
      }
    }
    return sortByName(matches);
  }
}

/** Sort each contact's segments by name, the same way for static and dynamic segments. */
function sortByName(segments: Map<string, SegmentRef[]>): Map<string, SegmentRef[]> {
  for (const list of segments.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return segments;
}
