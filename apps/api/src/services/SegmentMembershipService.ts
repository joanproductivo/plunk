import type {Segment} from '@plunk/db';
import {segmentEventName} from '@plunk/shared';
import type {BulkSegmentOperation, SegmentEventKind} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

import {EventService} from './EventService.js';
import {QueueService} from './QueueService.js';

/**
 * How a segment membership change behaves (static, or Plunk Lite: a dynamic segment's recomputation):
 * - `await`: entry/exit events, and the workflows they start, run before returning
 * - `background`: events go to the segment-membership-events queue, so callers (HTTP requests,
 *   bulk jobs) are not held up by workflows and the events survive a restart
 * - `silent`: imports. No events, and contacts already in the segment are left as they are
 *
 * Outside `silent`, adding a contact who is already a member counts as a new entry: `enteredAt`
 * is reset and the entry event fires again, so e.g. signing up twice re-runs the workflow.
 */
export type MembershipMode = 'await' | 'background' | 'silent';

type MembershipAction = 'add contacts to' | 'remove contacts from';

/** The action each bulk segment operation names in `getStaticSegment`'s errors */
export const BULK_SEGMENT_ACTION: Record<BulkSegmentOperation, MembershipAction> = {
  addToSegment: 'add contacts to',
  removeFromSegment: 'remove contacts from',
};

/**
 * Writes static segment memberships by contact ID, and (Plunk Lite) the changes a dynamic segment's
 * recomputation found, and fires the segment's entry/exit events when it tracks membership.
 * Contacts outside the project are ignored.
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
    action: MembershipAction,
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
   * Plunk Lite: write the membership changes computeMembership found for a dynamic segment, and
   * fire their events. Each write claims its rows (an insert that skips existing ones, updates
   * guarded on `exitedAt`), so two computations at once -- the job and a request -- enter or leave
   * each contact once, without a lock or a transaction holding a connection.
   */
  public static async applyComputedMembership(
    projectId: string,
    segment: Segment,
    toAdd: string[],
    toRemove: string[],
    {mode}: {mode: Exclude<MembershipMode, 'silent'>},
  ): Promise<{added: number; removed: number}> {
    const BATCH_SIZE = 500;
    let added = 0;
    let removed = 0;

    for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
      const batch = toAdd.slice(i, i + BATCH_SIZE);
      const now = new Date();
      const created = await prisma.segmentMembership.createManyAndReturn({
        data: batch.map(contactId => ({segmentId: segment.id, contactId, enteredAt: now})),
        skipDuplicates: true,
        select: {contactId: true},
      });
      const returning = await prisma.segmentMembership.updateManyAndReturn({
        where: {segmentId: segment.id, contactId: {in: batch}, exitedAt: {not: null}},
        data: {exitedAt: null, enteredAt: now},
        select: {contactId: true},
      });
      const entered = [...created, ...returning].map(m => m.contactId);
      added += entered.length;
      await this.trackMembershipEvents(projectId, segment, entered, 'entry', mode);
    }

    for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
      const batch = toRemove.slice(i, i + BATCH_SIZE);
      const left = await prisma.segmentMembership.updateManyAndReturn({
        where: {segmentId: segment.id, contactId: {in: batch}, exitedAt: null},
        data: {exitedAt: new Date()},
        select: {contactId: true},
      });
      removed += left.length;
      await this.trackMembershipEvents(
        projectId,
        segment,
        left.map(m => m.contactId),
        'exit',
        mode,
      );
    }

    return {added, removed};
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

    if (mode === 'await') {
      await EventService.trackEventsSequentially(projectId, segmentEventName(segment.name, kind), contactIds, {
        segmentId: segment.id,
        segmentName: segment.name,
      });
      return;
    }

    // The membership is already written, so a queue that cannot take the job must not fail the
    // caller: a retried request would write the change again and, re-entering, queue it again
    await QueueService.queueWithoutWaiting(
      QueueService.queueSegmentMembershipEvents({
        projectId,
        segmentId: segment.id,
        segmentName: segment.name,
        kind,
        contactIds,
      }),
      `${kind} events for segment ${segment.id}`,
    );
  }
}
