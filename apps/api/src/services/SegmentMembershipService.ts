import type {Segment} from '@plunk/db';
import {type SegmentEventKind, segmentEventName} from '@plunk/shared';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

import {EventService} from './EventService.js';

/**
 * How a static segment membership change behaves:
 * - `await`: entry/exit events are tracked before returning (bulk jobs, workflow steps)
 * - `background`: events are tracked without waiting, so HTTP callers are not held up by workflows
 * - `silent`: imports. No events, and contacts already in the segment are left as they are
 *
 * Outside `silent`, adding a contact who is already a member counts as a new entry: `enteredAt`
 * is reset and the entry event fires again, so e.g. signing up twice re-runs the workflow.
 */
export type MembershipMode = 'await' | 'background' | 'silent';

/**
 * Writes static segment memberships by contact ID and fires the segment's entry/exit events when
 * it tracks membership. Contacts outside the project are ignored.
 *
 * Counts and events follow the rows each write actually changed, so concurrent calls do not
 * double-count. Not transactional: rows that were written stay correct if a later step fails, and
 * the segment-count job recomputes `memberCount` every few minutes.
 *
 * Kept apart from SegmentService, which builds on it, so it can resolve segments without a
 * circular import (hence its own lookup in `getStaticSegment`).
 */
export class SegmentMembershipService {
  /**
   * Get a segment of the project that accepts manual membership changes
   */
  public static async getStaticSegment(
    projectId: string,
    segmentId: string,
    action: 'add contacts to' | 'remove contacts from',
  ): Promise<Segment> {
    const segment = await prisma.segment.findFirst({where: {id: segmentId, projectId}});

    if (!segment) {
      throw new HttpException(404, 'Segment not found');
    }

    if (segment.type !== 'STATIC') {
      throw new HttpException(400, `Can only ${action} STATIC segments`);
    }

    return segment;
  }

  /**
   * Add contacts to a static segment. `added` counts the contacts that entered it.
   */
  public static async addMembers(
    projectId: string,
    segmentId: string,
    contactIds: string[],
    {mode}: {mode: MembershipMode},
  ): Promise<{added: number}> {
    const segment = await this.getStaticSegment(projectId, segmentId, 'add contacts to');
    const ids = await this.projectContactIds(projectId, contactIds);

    if (ids.length === 0) {
      return {added: 0};
    }

    const now = new Date();

    const created = await prisma.segmentMembership.createManyAndReturn({
      data: ids.map(contactId => ({segmentId, contactId, enteredAt: now})),
      skipDuplicates: true,
      select: {contactId: true},
    });

    const returning = await prisma.segmentMembership.updateManyAndReturn({
      where: {segmentId, contactId: {in: ids}, exitedAt: {not: null}},
      data: {exitedAt: null, enteredAt: now},
      select: {contactId: true},
    });

    const joined = created.length + returning.length;
    if (joined > 0) {
      await prisma.segment.update({where: {id: segmentId}, data: {memberCount: {increment: joined}}});
    }

    const enteredIds = new Set([...created, ...returning].map(m => m.contactId));

    if (mode !== 'silent') {
      // Members who were already in the segment re-enter it
      const reentered = await prisma.segmentMembership.updateManyAndReturn({
        where: {segmentId, contactId: {in: ids.filter(id => !enteredIds.has(id))}, exitedAt: null},
        data: {enteredAt: now},
        select: {contactId: true},
      });
      reentered.forEach(m => enteredIds.add(m.contactId));
    }

    const entered = ids.filter(id => enteredIds.has(id));
    await this.trackMembershipEvents(projectId, segment, entered, 'entry', mode);

    return {added: entered.length};
  }

  /**
   * Remove contacts from a static segment. `removed` counts the contacts that were members,
   * `matched` the ones that belong to the project.
   */
  public static async removeMembers(
    projectId: string,
    segmentId: string,
    contactIds: string[],
    {mode}: {mode: Exclude<MembershipMode, 'silent'>},
  ): Promise<{removed: number; matched: number}> {
    const segment = await this.getStaticSegment(projectId, segmentId, 'remove contacts from');
    const ids = await this.projectContactIds(projectId, contactIds);

    if (ids.length === 0) {
      return {removed: 0, matched: 0};
    }

    const left = await prisma.segmentMembership.updateManyAndReturn({
      where: {segmentId, contactId: {in: ids}, exitedAt: null},
      data: {exitedAt: new Date()},
      select: {contactId: true},
    });

    if (left.length > 0) {
      await prisma.segment.update({where: {id: segmentId}, data: {memberCount: {decrement: left.length}}});
    }

    const leftIds = new Set(left.map(m => m.contactId));
    await this.trackMembershipEvents(
      projectId,
      segment,
      ids.filter(id => leftIds.has(id)),
      'exit',
      mode,
    );

    return {removed: left.length, matched: ids.length};
  }

  /**
   * The given contact IDs that belong to the project, deduplicated, in their original order
   */
  private static async projectContactIds(projectId: string, contactIds: string[]): Promise<string[]> {
    const unique = [...new Set(contactIds)];
    if (unique.length === 0) {
      return [];
    }

    const contacts = await prisma.contact.findMany({
      where: {projectId, id: {in: unique}},
      select: {id: true},
    });
    const found = new Set(contacts.map(c => c.id));

    return unique.filter(id => found.has(id));
  }

  private static async trackMembershipEvents(
    projectId: string,
    segment: Segment,
    contactIds: string[],
    kind: SegmentEventKind,
    mode: MembershipMode,
  ): Promise<void> {
    if (mode === 'silent' || !segment.trackMembership || contactIds.length === 0) {
      return;
    }

    const events = EventService.trackEventsSequentially(projectId, segmentEventName(segment.name, kind), contactIds, {
      segmentId: segment.id,
      segmentName: segment.name,
    });

    if (mode === 'await') {
      await events;
      return;
    }

    events.catch(error => {
      signale.error(`[SEGMENT] Failed to track ${kind} events for segment ${segment.id}:`, error);
    });
  }
}
