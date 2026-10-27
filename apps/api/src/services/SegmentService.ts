import {type CampaignStatus, type Contact, Prisma, type Segment} from '@plunk/db';
import type {FilterCondition, FilterGroup, PaginatedResponse, SegmentFilter, SegmentType} from '@plunk/types';
import {fromPrismaJson, toPrismaJson} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
// The cascade over a big static segment's memberships can outlast Prisma's 5 s default
import {LONG_TRANSACTION} from '../utils/database.js';

import {ContactService} from './ContactService.js';
import {NtfyService} from './NtfyService.js';
import {SegmentMembershipService} from './SegmentMembershipService.js';
import {SuppressionService} from './SuppressionService.js';

export type {FilterCondition, FilterGroup, SegmentFilter} from '@plunk/types';

/** Campaigns in these states still send to their segment, so it cannot be deleted. */
const ACTIVE_CAMPAIGN_STATUSES: CampaignStatus[] = ['DRAFT', 'SCHEDULED', 'SENDING'];
/**
 * Most blocked segments a refused bulk delete names, and most workflows, segments or filtered
 * campaigns a refused delete names for each one.
 */
const MAX_BLOCKED_SEGMENTS_LISTED = 5;
const MAX_BLOCKING_NAMES_LISTED = 3;

/** `"A", "B", "C"`, or `"A", "B" and 3 more` past `max` names. */
function listNames(names: string[], max: number): string {
  const shown = names
    .slice(0, max)
    .map(name => `"${name}"`)
    .join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export class SegmentService {
  /**
   * Get all segments for a project
   * Uses cached member counts for performance - counts are updated via background job
   */
  public static async list(projectId: string): Promise<Segment[]> {
    return prisma.segment.findMany({
      where: {projectId},
      orderBy: {createdAt: 'desc'},
    });
  }

  /**
   * Get a single segment by ID
   * Uses cached member count for performance - counts are updated via background job
   */
  public static async get(projectId: string, segmentId: string): Promise<Segment> {
    const segment = await prisma.segment.findFirst({
      where: {
        id: segmentId,
        projectId,
      },
    });

    if (!segment) {
      throw new HttpException(404, 'Segment not found');
    }

    return segment;
  }

  /**
   * Whether a contact is in a segment right now: a current member of a static segment, or a
   * match for a dynamic segment's filter (evaluated live, like the member counts). False when
   * the segment is missing or belongs to another project, or its filter cannot be built (e.g.
   * it references a deleted segment). A database error is thrown, so the caller fails rather
   * than taking the "not a member" path by mistake.
   */
  public static async isMember(projectId: string, segmentId: string, contactId: string): Promise<boolean> {
    const segment = await prisma.segment.findFirst({
      where: {id: segmentId, projectId},
      select: {type: true, condition: true},
    });
    if (!segment) {
      signale.warn(`[SEGMENT] Membership check on missing segment ${segmentId}`);
      return false;
    }

    if (segment.type === 'STATIC') {
      const membership = await prisma.segmentMembership.findUnique({
        where: {contactId_segmentId: {contactId, segmentId}},
        select: {exitedAt: true},
      });
      return membership !== null && membership.exitedAt === null;
    }

    let where: Prisma.ContactWhereInput;
    try {
      where = await this.buildConditionClause(projectId, fromPrismaJson<FilterCondition>(segment.condition));
    } catch (error) {
      signale.warn(`[SEGMENT] Membership check on segment ${segmentId}: its filter cannot be built:`, error);
      return false;
    }

    const match = await prisma.contact.findFirst({
      where: {AND: [{id: contactId, projectId}, where]},
      select: {id: true},
    });
    return match !== null;
  }

  /**
   * Get contacts that match a segment's condition
   */
  public static async getContacts(
    projectId: string,
    segmentId: string,
    page = 1,
    pageSize = 20,
  ): Promise<PaginatedResponse<Contact>> {
    const segment = await this.get(projectId, segmentId);
    const skip = (page - 1) * pageSize;

    if (segment.type === 'STATIC') {
      // For static segments, query via SegmentMembership records
      const [memberships, total] = await Promise.all([
        prisma.segmentMembership.findMany({
          where: {segmentId, exitedAt: null},
          include: {contact: true},
          skip,
          take: pageSize,
          orderBy: {enteredAt: 'desc'},
        }),
        prisma.segmentMembership.count({where: {segmentId, exitedAt: null}}),
      ]);

      return {
        data: memberships.map(m => m.contact),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }

    const condition = fromPrismaJson<FilterCondition>(segment.condition);
    const where = await this.buildWhereClause(projectId, condition);

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: {createdAt: 'desc'},
      }),
      prisma.contact.count({where}),
    ]);

    return {
      data: contacts,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Create a new segment
   */
  public static async create(
    projectId: string,
    data: {
      name: string;
      description?: string;
      type?: SegmentType;
      condition?: FilterCondition;
      trackMembership?: boolean;
    },
  ): Promise<Segment> {
    const segmentType = data.type ?? 'DYNAMIC';
    let memberCount = 0;
    let conditionJson: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;

    if (segmentType === 'DYNAMIC') {
      if (!data.condition) {
        throw new HttpException(400, 'Condition is required for DYNAMIC segments');
      }
      // Validate condition
      this.validateCondition(data.condition);

      // Compute initial member count
      const where = await this.buildWhereClause(projectId, data.condition);
      memberCount = await prisma.contact.count({where});
      conditionJson = toPrismaJson(data.condition);
    }

    const segment = await prisma.segment.create({
      data: {
        projectId,
        name: data.name,
        description: data.description,
        type: segmentType,
        condition: conditionJson,
        trackMembership: data.trackMembership ?? false,
        memberCount,
      },
      include: {
        project: {
          select: {name: true},
        },
      },
    });

    // Notify about segment creation
    await NtfyService.notifySegmentCreated(segment.name, segment.project.name, projectId);

    return segment;
  }

  /**
   * Update a segment
   */
  public static async update(
    projectId: string,
    segmentId: string,
    data: {
      name?: string;
      description?: string;
      condition?: FilterCondition;
      trackMembership?: boolean;
    },
  ): Promise<Segment> {
    // First verify segment exists and belongs to project
    const existing = await this.get(projectId, segmentId);

    const updateData: Prisma.SegmentUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.condition !== undefined && existing.type !== 'STATIC') {
      // Validate condition if provided (only for DYNAMIC segments)
      this.validateCondition(data.condition);

      if (this.getReferencedSegmentIds(data.condition).has(segmentId)) {
        throw new HttpException(400, 'A segment cannot reference itself');
      }
      updateData.condition = toPrismaJson(data.condition);

      // Recompute member count when condition changes
      const where = await this.buildWhereClause(projectId, data.condition);
      updateData.memberCount = await prisma.contact.count({where});
    }
    if (data.trackMembership !== undefined) {
      updateData.trackMembership = data.trackMembership;
    }

    return prisma.segment.update({
      where: {id: segmentId},
      data: updateData,
    });
  }

  /**
   * Delete a segment
   */
  public static async delete(projectId: string, segmentId: string): Promise<void> {
    // First verify segment exists and belongs to project
    const segment = await prisma.segment.findFirst({
      where: {
        id: segmentId,
        projectId,
      },
      include: {
        project: {
          select: {name: true},
        },
      },
    });

    if (!segment) {
      throw new HttpException(404, 'Segment not found');
    }

    const blockers = (await this.deletionBlockers(prisma, projectId, [segmentId])).get(segmentId);

    // Check if segment is used in any active campaigns
    if (blockers?.campaigns) {
      throw new HttpException(
        409,
        `Cannot delete segment: it is currently used in ${blockers.campaigns} active campaign(s). Remove it from campaigns first or wait for them to complete.`,
      );
    }

    if (blockers?.filteredCampaigns.length) {
      throw new HttpException(
        409,
        `Cannot delete segment: the audience filter of the active campaign(s) ${listNames(blockers.filteredCampaigns, MAX_BLOCKING_NAMES_LISTED)} uses it. Remove it from their audience first or wait for them to complete.`,
      );
    }

    if (blockers?.workflows.length) {
      throw new HttpException(
        409,
        `Cannot delete segment: it is used by the workflow(s) ${blockers.workflows.map(name => `"${name}"`).join(', ')}. Remove it from their Update contact and Condition steps first.`,
      );
    }

    if (blockers?.segments.length) {
      throw new HttpException(
        409,
        `Cannot delete segment: the condition of the segment(s) ${listNames(blockers.segments, MAX_BLOCKING_NAMES_LISTED)} uses it. Remove it from their conditions first.`,
      );
    }

    await prisma.segment.delete({
      where: {id: segmentId},
    });

    // Notify about segment deletion
    await NtfyService.notifySegmentDeleted(segment.name, segment.project.name, projectId);
  }

  /**
   * Apply a bulk operation to several segments. Only `delete` exists: it deletes all of them or,
   * when any is missing or still used by an active campaign, a workflow or a segment outside the
   * batch, none.
   */
  public static async bulkUpdate(
    projectId: string,
    options: {ids: string[]; delete?: boolean},
  ): Promise<{deleted?: number; updated?: number}> {
    const ids = Array.from(new Set(options.ids));
    if (!options.delete || ids.length === 0) {
      return {updated: 0};
    }

    const {deleted, projectName} = await prisma.$transaction(async tx => {
      // Locks the rows first, so a campaign pointed at one of them meanwhile either is seen by the
      // check below or waits and then fails on its foreign key; a concurrent bulk delete of the
      // same segments waits too and then finds them gone.
      await tx.$queryRaw`SELECT 1 FROM segments WHERE id IN (${Prisma.join(ids)}) AND "projectId" = ${projectId} FOR UPDATE`;
      const segments = await tx.segment.findMany({
        where: {id: {in: ids}, projectId},
        select: {id: true, name: true, project: {select: {name: true}}},
        orderBy: {name: 'asc'},
      });
      if (segments.length !== ids.length) {
        throw new HttpException(404, 'One or more segments not found in this project');
      }

      const blockers = await this.deletionBlockers(tx, projectId, ids);
      const reasons = segments.flatMap(segment => {
        const blocker = blockers.get(segment.id);
        const uses = [
          blocker?.campaigns ? `${blocker.campaigns} active campaign(s)` : null,
          blocker?.filteredCampaigns.length
            ? `the audience filter of the active campaign(s) ${listNames(blocker.filteredCampaigns, MAX_BLOCKING_NAMES_LISTED)}`
            : null,
          blocker?.workflows.length
            ? `the workflow(s) ${listNames(blocker.workflows, MAX_BLOCKING_NAMES_LISTED)}`
            : null,
          blocker?.segments.length
            ? `the condition of the segment(s) ${listNames(blocker.segments, MAX_BLOCKING_NAMES_LISTED)}`
            : null,
        ].filter(Boolean);
        const last = uses.pop();
        return last ? [`"${segment.name}" is used by ${uses.length > 0 ? `${uses.join(', ')} and ` : ''}${last}`] : [];
      });
      if (reasons.length > 0) {
        const shown = reasons.slice(0, MAX_BLOCKED_SEGMENTS_LISTED);
        const more = reasons.length - shown.length;
        throw new HttpException(
          409,
          `Nothing was deleted. ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}. Remove them from those first.`,
        );
      }

      const {count} = await tx.segment.deleteMany({where: {id: {in: ids}, projectId}});
      if (count !== segments.length) {
        throw new HttpException(
          409,
          'The segments changed while they were being deleted. Nothing was deleted; try again.',
        );
      }
      return {deleted: segments, projectName: segments[0]!.project.name};
    }, LONG_TRANSACTION);

    await Promise.allSettled(
      deleted.map(segment => NtfyService.notifySegmentDeleted(segment.name, projectName, projectId)),
    );

    return {deleted: deleted.length};
  }

  /**
   * What keeps each segment from being deleted: how many active campaigns send to it, the names of
   * the active campaigns whose audience filter uses its `segment.<id>` field, the names of the
   * workflows with an Update contact step that adds or removes it or a Condition step on that
   * field, and the names of the other segments whose condition uses that field. Segments among
   * `segmentIds` do not count, since they go together. Triggers and waits on its
   * `segment.<slug>.*` events are not tracked: the slug follows the name and is not unique.
   * Segments nothing uses are left out.
   */
  private static async deletionBlockers(
    db: Prisma.TransactionClient,
    projectId: string,
    segmentIds: string[],
  ): Promise<Map<string, {campaigns: number; filteredCampaigns: string[]; workflows: string[]; segments: string[]}>> {
    const blockers = new Map<
      string,
      {campaigns: number; filteredCampaigns: Set<string>; workflows: Set<string>; segments: Set<string>}
    >();
    const blockerFor = (segmentId: string) => {
      let blocker = blockers.get(segmentId);
      if (!blocker) {
        blocker = {campaigns: 0, filteredCampaigns: new Set(), workflows: new Set(), segments: new Set()};
        blockers.set(segmentId, blocker);
      }
      return blocker;
    };

    const campaigns = await db.campaign.groupBy({
      by: ['segmentId'],
      where: {projectId, segmentId: {in: segmentIds}, status: {in: ACTIVE_CAMPAIGN_STATUSES}},
      _count: {_all: true},
    });
    for (const {segmentId, _count} of campaigns) {
      if (segmentId) blockerFor(segmentId).campaigns = _count._all;
    }

    // One query whatever the number of segments; which segment each step uses is worked out here.
    const wanted = new Set(segmentIds);
    const steps = await db.workflowStep.findMany({
      where: {workflow: {projectId}, type: {in: ['CONDITION', 'UPDATE_CONTACT']}},
      select: {type: true, config: true, workflow: {select: {name: true}}},
    });
    for (const step of steps) {
      const config = step.config as {field?: unknown; segments?: {add?: unknown; remove?: unknown}} | null;
      const used =
        step.type === 'CONDITION'
          ? typeof config?.field === 'string' && config.field.startsWith('segment.')
            ? [config.field.slice('segment.'.length)]
            : []
          : [config?.segments?.add, config?.segments?.remove].flatMap(list =>
              Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [],
            );
      for (const segmentId of used) {
        if (wanted.has(segmentId)) blockerFor(segmentId).workflows.add(step.workflow.name);
      }
    }

    // Conditions were validated when saved, so they can be walked as filter conditions. Like the
    // steps above, one query each, and the ids are matched here.
    const filteredCampaigns = await db.campaign.findMany({
      where: {projectId, audienceType: 'FILTERED', status: {in: ACTIVE_CAMPAIGN_STATUSES}},
      select: {name: true, audienceCondition: true},
    });
    for (const campaign of filteredCampaigns) {
      if (!campaign.audienceCondition) continue;
      for (const segmentId of this.getReferencedSegmentIds(
        fromPrismaJson<FilterCondition>(campaign.audienceCondition),
      )) {
        if (wanted.has(segmentId)) blockerFor(segmentId).filteredCampaigns.add(campaign.name);
      }
    }

    const referencing = await db.segment.findMany({
      where: {projectId, id: {notIn: segmentIds}, type: 'DYNAMIC'},
      select: {name: true, condition: true},
    });
    for (const segment of referencing) {
      if (!segment.condition) continue;
      for (const segmentId of this.getReferencedSegmentIds(fromPrismaJson<FilterCondition>(segment.condition))) {
        if (wanted.has(segmentId)) blockerFor(segmentId).segments.add(segment.name);
      }
    }

    const sorted = (names: Set<string>) => [...names].sort((a, b) => a.localeCompare(b));
    return new Map(
      [...blockers].map(([segmentId, blocker]) => [
        segmentId,
        {
          campaigns: blocker.campaigns,
          filteredCampaigns: sorted(blocker.filteredCampaigns),
          workflows: sorted(blocker.workflows),
          segments: sorted(blocker.segments),
        },
      ]),
    );
  }

  /**
   * Refresh segment member count (for background jobs or manual refresh)
   * This is now the primary way to update segment counts
   */
  public static async refreshMemberCount(projectId: string, segmentId: string): Promise<number> {
    const segment = await this.get(projectId, segmentId);

    let memberCount: number;

    if (segment.type === 'STATIC') {
      memberCount = await prisma.segmentMembership.count({where: {segmentId, exitedAt: null}});
    } else {
      const condition = fromPrismaJson<FilterCondition>(segment.condition);
      const where = await this.buildWhereClause(projectId, condition);
      memberCount = await prisma.contact.count({where});
    }

    await prisma.segment.update({
      where: {id: segmentId},
      data: {memberCount},
    });

    return memberCount;
  }

  /**
   * Refresh member counts for the segments of a project that do not track membership
   * Should be called by a background job periodically
   * Plunk Lite: the ones that track it get their count from computeMembership in the same job, so
   * counting them again here only doubled the work.
   */
  public static async refreshAllMemberCounts(projectId: string): Promise<void> {
    const segments = await prisma.segment.findMany({
      where: {projectId, trackMembership: false},
      select: {id: true, type: true, condition: true},
    });

    // Process in batches to avoid overwhelming the database
    const BATCH_SIZE = 5;
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async segment => {
          try {
            let memberCount: number;

            if (segment.type === 'STATIC') {
              memberCount = await prisma.segmentMembership.count({
                where: {segmentId: segment.id, exitedAt: null},
              });
            } else {
              const condition = fromPrismaJson<FilterCondition>(segment.condition);
              const where = await this.buildWhereClause(projectId, condition);
              memberCount = await prisma.contact.count({where});
            }

            await prisma.segment.update({
              where: {id: segment.id},
              data: {memberCount},
            });
          } catch (error) {
            signale.error(`Failed to update count for segment ${segment.id}:`, error);
          }
        }),
      );
    }
  }

  /**
   * Add contacts to a static segment by email. Contacts already in it re-enter it
   * (see SegmentMembershipService); entry events are fired in the background.
   */
  public static async addContacts(
    projectId: string,
    segmentId: string,
    emails: string[],
    createMissing = false,
    subscribed = true,
  ): Promise<{added: number; created: number; notFound: string[]}> {
    // Checked before any contact is created for a segment that cannot take them
    await SegmentMembershipService.getStaticSegment(projectId, segmentId, 'add contacts to');

    // Emails are stored normalized, so look up (and create) on the normalized
    // value. Dedupe first so case-variants in the same request collapse to one.
    const normalizedEmails = [...new Set(emails.map(e => ContactService.normalizeEmail(e)))];

    let contacts = await prisma.contact.findMany({
      where: {
        projectId,
        email: {in: normalizedEmails},
      },
      select: {id: true, email: true},
    });

    let foundEmails = new Set(contacts.map(c => c.email));
    const missing = normalizedEmails.filter(e => !foundEmails.has(e));

    let created = 0;
    if (createMissing && missing.length > 0) {
      // A suppressed address is created unsubscribed
      const suppressed = subscribed ? await SuppressionService.suppressedAmong(projectId, missing) : new Map();
      await prisma.contact.createMany({
        data: missing.map(email => ({projectId, email, subscribed: subscribed && !suppressed.has(email)})),
        skipDuplicates: true,
      });
      created = missing.length;
      // Re-fetch to include newly created contacts
      contacts = await prisma.contact.findMany({
        where: {projectId, email: {in: normalizedEmails}},
        select: {id: true, email: true},
      });
      foundEmails = new Set(contacts.map(c => c.email));
    }

    // Report unmatched addresses using the caller's original input strings.
    const notFound = emails.filter(e => !foundEmails.has(ContactService.normalizeEmail(e)));

    const {added} = await SegmentMembershipService.addMembers(
      projectId,
      segmentId,
      contacts.map(c => c.id),
      {mode: 'background'},
    );

    return {added, created, notFound};
  }

  /**
   * Remove contacts from a static segment by email. `removed` counts the contacts that were
   * members; exit events are fired in the background.
   */
  public static async removeContacts(
    projectId: string,
    segmentId: string,
    emails: string[],
  ): Promise<{removed: number}> {
    // Emails are stored normalized, so look up on the normalized value
    const normalizedEmails = [...new Set(emails.map(e => ContactService.normalizeEmail(e)))];
    const contacts = await prisma.contact.findMany({
      where: {projectId, email: {in: normalizedEmails}},
      select: {id: true},
    });

    const {removed} = await SegmentMembershipService.removeMembers(
      projectId,
      segmentId,
      contacts.map(c => c.id),
      {mode: 'background'},
    );

    return {removed};
  }

  /**
   * Compute or recompute segment membership for all contacts
   * Now uses cursor-based pagination for memory efficiency with large contact lists
   */
  public static async computeMembership(
    projectId: string,
    segmentId: string,
    // Plunk Lite: a request queues the entry/exit events instead of running their workflows inline
    {events = 'await'}: {events?: 'await' | 'background'} = {},
  ): Promise<{added: number; removed: number; total: number}> {
    const segment = await this.get(projectId, segmentId);

    if (!segment.trackMembership) {
      throw new HttpException(400, 'Segment does not have membership tracking enabled');
    }

    if (segment.type === 'STATIC') {
      // For static segments, just update the count from memberships — no contact scanning
      const total = await prisma.segmentMembership.count({where: {segmentId, exitedAt: null}});
      await prisma.segment.update({where: {id: segmentId}, data: {memberCount: total}});
      return {added: 0, removed: 0, total};
    }

    const condition = fromPrismaJson<FilterCondition>(segment.condition);
    const where = await this.buildWhereClause(projectId, condition);

    // Get all matching contacts using cursor-based pagination to avoid memory issues
    const BATCH_SIZE = 1000;
    const matchingContactIds = new Set<string>();
    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const contacts: {id: string}[] = await prisma.contact.findMany({
        where,
        select: {id: true},
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? {id: cursor} : undefined,
        orderBy: {id: 'asc'},
      });

      contacts.forEach((c: {id: string}) => matchingContactIds.add(c.id));

      if (contacts.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        const lastContact = contacts[contacts.length - 1];
        cursor = lastContact?.id;
      }
    }

    // Get current active memberships using cursor pagination
    const currentMemberIds = new Set<string>();
    cursor = undefined;
    hasMore = true;

    while (hasMore) {
      const memberships: {contactId: string}[] = await prisma.segmentMembership.findMany({
        where: {
          segmentId,
          exitedAt: null,
        },
        select: {contactId: true},
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? {contactId_segmentId: {contactId: cursor, segmentId}} : undefined,
        orderBy: {contactId: 'asc'},
      });

      memberships.forEach((m: {contactId: string}) => currentMemberIds.add(m.contactId));

      if (memberships.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        const lastMembership = memberships[memberships.length - 1];
        cursor = lastMembership?.contactId;
      }
    }

    // Calculate changes
    const toAdd = Array.from(matchingContactIds).filter(id => !currentMemberIds.has(id));
    const toRemove = Array.from(currentMemberIds).filter(id => !matchingContactIds.has(id));

    // Plunk Lite: written by claiming each row, so two computations at once (the job and a request)
    // enter or leave each contact once and fire its event once
    const {added, removed} = await SegmentMembershipService.applyComputedMembership(
      projectId,
      segment,
      toAdd,
      toRemove,
      {mode: events},
    );

    // Update member count on segment, from what is written
    const total = await prisma.segmentMembership.count({where: {segmentId, exitedAt: null}});
    await prisma.segment.update({
      where: {id: segmentId},
      data: {memberCount: total},
    });

    signale.info(`[SEGMENT] Computed membership for segment ${segmentId}: added ${added}, removed ${removed}, total ${total}`);

    return {added, removed, total};
  }

  /**
   * Build a single filter condition. A referenced segment is looked up in the project only.
   */
  public static async buildFilterCondition(
    projectId: string,
    filter: SegmentFilter,
    visitedSegments = new Set<string>(),
  ): Promise<Prisma.ContactWhereInput> {
    const {field, operator, value, unit} = filter;

    // Handle segment membership filters (e.g., "segment.<segmentId>")
    if (field.startsWith('segment.')) {
      const segmentId = field.substring(8);

      if (visitedSegments.has(segmentId)) {
        throw new HttpException(400, 'Circular segment reference detected');
      }

      const referencedSegment = await prisma.segment.findFirst({
        where: {id: segmentId, projectId},
      });

      if (!referencedSegment) {
        throw new HttpException(400, `Referenced segment not found: ${segmentId}`);
      }

      if (referencedSegment.type === 'STATIC' || referencedSegment.trackMembership) {
        // Filter through the membership table of static or tracked segments rather than loading
        // the members: a list of ids grows with the segment and stops working past Postgres'
        // 32,767 bind variables.
        const activeMembership = {segmentId, exitedAt: null};

        if (operator === 'memberOfSegment') {
          return {segmentMemberships: {some: activeMembership}};
        }

        return {segmentMemberships: {none: activeMembership}};
      }

      // For untracked dynamic segments, evaluate the condition recursively
      const nestedCondition = fromPrismaJson<FilterCondition>(referencedSegment.condition);
      const nextVisited = new Set(visitedSegments).add(segmentId);
      const nestedWhere = await this.buildConditionClause(projectId, nestedCondition, nextVisited);

      if (operator === 'memberOfSegment') {
        return nestedWhere;
      }

      return {NOT: nestedWhere};
    }

    // Handle event-based filters (e.g., "event.upgrade", "event.purchase")
    if (field.startsWith('event.')) {
      const eventName = field.substring(6); // Remove "event." prefix
      return this.buildEventCondition(eventName, operator, value, unit);
    }

    // Handle email activity filters (e.g., "email.opened", "email.clicked")
    if (field.startsWith('email.')) {
      const activity = field.substring(6); // Remove "email." prefix
      return this.buildEmailActivityCondition(activity, operator, value, unit);
    }

    // Handle JSON field paths (e.g., "data.plan")
    if (field.startsWith('data.')) {
      const jsonPath = field.substring(5); // Remove "data." prefix
      return this.buildJsonFieldCondition(jsonPath, operator, value, unit);
    }

    // Handle regular fields
    switch (field) {
      case 'email':
        return this.buildStringFieldCondition('email', operator, value);
      case 'subscribed':
        return this.buildBooleanFieldCondition('subscribed', operator, value);
      case 'createdAt':
      case 'updatedAt':
        return this.buildDateFieldCondition(field, operator, value, unit);
      default:
        throw new HttpException(400, `Unsupported filter field: ${field}`);
    }
  }

  /**
   * Collect all segment IDs directly referenced in a condition (non-recursive DB lookup)
   */
  private static getReferencedSegmentIds(condition: FilterCondition): Set<string> {
    const ids = new Set<string>();
    for (const group of condition.groups) {
      for (const filter of group.filters) {
        if (filter.field.startsWith('segment.')) {
          ids.add(filter.field.substring(8));
        }
      }
      if (group.conditions) {
        for (const id of this.getReferencedSegmentIds(group.conditions)) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  /**
   * Validate segment condition (recursive)
   */
  public static validateCondition(condition: FilterCondition): void {
    if (!condition || typeof condition !== 'object') {
      throw new HttpException(400, 'Condition must be an object');
    }

    if (!condition.logic || !['AND', 'OR'].includes(condition.logic)) {
      throw new HttpException(400, 'Condition logic must be either "AND" or "OR"');
    }

    if (!Array.isArray(condition.groups) || condition.groups.length === 0) {
      throw new HttpException(400, 'Condition must have at least one group');
    }

    for (const group of condition.groups) {
      this.validateGroup(group);
    }
  }

  /**
   * Build Prisma clause from filter condition (recursive)
   */
  public static async buildConditionClause(
    projectId: string,
    condition: FilterCondition,
    visitedSegments = new Set<string>(),
  ): Promise<Prisma.ContactWhereInput> {
    const groupClauses = await Promise.all(
      condition.groups.map(group => this.buildGroupClause(projectId, group, visitedSegments)),
    );

    if (condition.logic === 'AND') {
      return {AND: groupClauses};
    } else {
      return {OR: groupClauses};
    }
  }

  /**
   * Validate filter group (recursive)
   */
  private static validateGroup(group: FilterGroup): void {
    if (!group || typeof group !== 'object') {
      throw new HttpException(400, 'Group must be an object');
    }

    if (!Array.isArray(group.filters)) {
      throw new HttpException(400, 'Group filters must be an array');
    }

    // Groups can have filters, nested conditions, or both
    const hasFilters = group.filters.length > 0;
    const hasConditions = group.conditions !== undefined;

    if (!hasFilters && !hasConditions) {
      throw new HttpException(400, 'Group must have at least one filter or nested condition');
    }

    // Validate all filters in the group
    for (const filter of group.filters) {
      this.validateFilter(filter);
    }

    // Recursively validate nested conditions
    if (group.conditions) {
      this.validateCondition(group.conditions);
    }
  }

  /**
   * Validate individual filter
   */
  private static validateFilter(filter: SegmentFilter): void {
    if (!filter.field) {
      throw new HttpException(400, 'Filter field is required');
    }

    if (!filter.operator) {
      throw new HttpException(400, 'Filter operator is required');
    }

    const validOperators = [
      'equals',
      'notEquals',
      'contains',
      'notContains',
      'greaterThan',
      'lessThan',
      'greaterThanOrEqual',
      'lessThanOrEqual',
      'exists',
      'notExists',
      'within',
      'olderThan',
      'triggered',
      'triggeredWithin',
      'triggeredOlderThan',
      'notTriggered',
      'notTriggeredWithin',
      'memberOfSegment',
      'notMemberOfSegment',
    ];

    if (!validOperators.includes(filter.operator)) {
      throw new HttpException(400, `Invalid operator: ${filter.operator}`);
    }

    // Segment membership operators use the segmentId encoded in the field name, no separate value needed
    if (filter.operator === 'memberOfSegment' || filter.operator === 'notMemberOfSegment') {
      if (!filter.field.startsWith('segment.')) {
        throw new HttpException(400, 'memberOfSegment/notMemberOfSegment operators require a segment field (segment.<id>)');
      }
      return;
    }

    // Validate that operators that need a value have one
    const operatorsNeedingValue = [
      'equals',
      'notEquals',
      'contains',
      'notContains',
      'greaterThan',
      'lessThan',
      'greaterThanOrEqual',
      'lessThanOrEqual',
      'within',
      'olderThan',
      'triggeredWithin',
      'triggeredOlderThan',
      'notTriggeredWithin',
    ];

    if (operatorsNeedingValue.includes(filter.operator) && filter.value === undefined) {
      throw new HttpException(400, `Operator "${filter.operator}" requires a value`);
    }

    // Validate unit for time-based operators
    if (['within', 'triggeredWithin', 'olderThan', 'triggeredOlderThan', 'notTriggeredWithin'].includes(filter.operator) && !filter.unit) {
      throw new HttpException(400, `"${filter.operator}" operator requires a unit (days, hours, or minutes)`);
    }
  }

  /**
   * Build Prisma where clause from filter condition (entry point)
   */
  private static async buildWhereClause(
    projectId: string,
    condition: FilterCondition,
  ): Promise<Prisma.ContactWhereInput> {
    return {
      projectId,
      ...(await this.buildConditionClause(projectId, condition)),
    };
  }

  /**
   * Build Prisma clause from filter group (recursive)
   */
  private static async buildGroupClause(
    projectId: string,
    group: FilterGroup,
    visitedSegments = new Set<string>(),
  ): Promise<Prisma.ContactWhereInput> {
    const clauses: Prisma.ContactWhereInput[] = [];

    // Add filter conditions from this group
    if (group.filters.length > 0) {
      const filterClauses = await Promise.all(
        group.filters.map(filter => this.buildFilterCondition(projectId, filter, visitedSegments)),
      );
      clauses.push(...filterClauses);
    }

    // Add nested condition if present
    if (group.conditions) {
      clauses.push(await this.buildConditionClause(projectId, group.conditions, visitedSegments));
    }

    // All conditions within a group are combined with AND
    if (clauses.length === 0) {
      return {}; // Empty group returns empty where clause
    }

    if (clauses.length === 1) {
      return clauses[0]!; // Safe to use non-null assertion since we checked length
    }

    return {AND: clauses};
  }

  /**
   * Build condition for JSON fields (stored in contact.data)
   */
  private static buildJsonFieldCondition(
    jsonPath: string,
    operator: string,
    value: unknown,
    unit?: 'days' | 'hours' | 'minutes',
  ): Prisma.ContactWhereInput {
    const path = jsonPath.split('.');

    switch (operator) {
      case 'equals':
        // For date strings, compare only the date portion (ignore time)
        if (this.isDateString(value)) {
          const {startOfDay, startOfNextDay} = this.getDateRange(String(value));
          return {
            AND: [
              {data: {path, gte: startOfDay as Prisma.InputJsonValue}},
              {data: {path, lt: startOfNextDay as Prisma.InputJsonValue}},
            ],
          };
        }
        return {data: {path, equals: value as Prisma.InputJsonValue}};
      case 'notEquals':
        // For date strings, exclude the entire day (not just exact timestamp)
        if (this.isDateString(value)) {
          const {startOfDay, startOfNextDay} = this.getDateRange(String(value));
          return {
            OR: [
              {data: {path, lt: startOfDay as Prisma.InputJsonValue}},
              {data: {path, gte: startOfNextDay as Prisma.InputJsonValue}},
            ],
          };
        }
        return {NOT: {data: {path, equals: value as Prisma.InputJsonValue}}};
      case 'contains':
        return {data: {path, string_contains: String(value)}};
      case 'notContains':
        return {NOT: {data: {path, string_contains: String(value)}}};
      case 'greaterThan':
        return {data: {path, gt: value as Prisma.InputJsonValue}};
      case 'lessThan':
        return {data: {path, lt: value as Prisma.InputJsonValue}};
      case 'greaterThanOrEqual':
        return {data: {path, gte: value as Prisma.InputJsonValue}};
      case 'lessThanOrEqual':
        return {data: {path, lte: value as Prisma.InputJsonValue}};
      case 'exists':
        // Exists = key present with a non-null JSON value (neither DbNull nor JsonNull)
        return {
          NOT: {
            OR: [{data: {path, equals: Prisma.DbNull}}, {data: {path, equals: Prisma.JsonNull}}],
          },
        };
      case 'notExists':
        // Not exists = key is null / missing, represented as either DbNull or JsonNull
        return {
          OR: [{data: {path, equals: Prisma.DbNull}}, {data: {path, equals: Prisma.JsonNull}}],
        };
      case 'within': {
        // Note: Requires JSON date fields in ISO 8601 format for proper comparison
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "within" operator');
        }

        // Calculate the "since" date (X time units ago from now)
        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        // Use ISO string for lexicographic comparison in JSON
        return {data: {path, gte: since.toISOString() as Prisma.InputJsonValue}};
      }
      case 'olderThan': {
        // Note: Requires JSON date fields in ISO 8601 format for proper comparison
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "olderThan" operator');
        }

        // Calculate the "before" date (X time units ago from now)
        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const before = new Date(now.getTime() - milliseconds);

        // Use ISO string for lexicographic comparison in JSON
        return {data: {path, lt: before.toISOString() as Prisma.InputJsonValue}};
      }
      default:
        throw new HttpException(400, `Unsupported operator for JSON field: ${operator}`);
    }
  }

  /**
   * Build condition for string fields
   */
  private static buildStringFieldCondition(field: 'email', operator: string, value: unknown): Prisma.ContactWhereInput {
    switch (operator) {
      case 'equals':
        return {[field]: {equals: String(value), mode: 'insensitive'}};
      case 'notEquals':
        return {NOT: {[field]: {equals: String(value), mode: 'insensitive'}}};
      case 'contains':
        return {[field]: {contains: String(value), mode: 'insensitive'}};
      case 'notContains':
        return {NOT: {[field]: {contains: String(value), mode: 'insensitive'}}};
      default:
        throw new HttpException(400, `Unsupported operator for string field: ${operator}`);
    }
  }

  /**
   * Build condition for boolean fields
   */
  private static buildBooleanFieldCondition(
    field: 'subscribed',
    operator: string,
    value: unknown,
  ): Prisma.ContactWhereInput {
    switch (operator) {
      case 'equals':
        return {[field]: value === true};
      case 'notEquals':
        return {[field]: value !== true};
      default:
        throw new HttpException(400, `Unsupported operator for boolean field: ${operator}`);
    }
  }

  /**
   * Build condition for date fields
   */
  private static buildDateFieldCondition(
    field: 'createdAt' | 'updatedAt',
    operator: string,
    value: unknown,
    unit?: 'days' | 'hours' | 'minutes',
  ): Prisma.ContactWhereInput {
    switch (operator) {
      case 'equals': {
        // For date fields, compare only the date portion (ignore time)
        if (this.isDateString(value)) {
          const {startOfDay, startOfNextDay} = this.getDateRange(String(value));
          return {
            AND: [{[field]: {gte: new Date(startOfDay)}}, {[field]: {lt: new Date(startOfNextDay)}}],
          };
        }
        // Exact timestamp match if not a date string
        return {[field]: new Date(value as string | number | Date)};
      }
      case 'notEquals': {
        // For date fields, exclude the entire day (not just exact timestamp)
        if (this.isDateString(value)) {
          const {startOfDay, startOfNextDay} = this.getDateRange(String(value));
          return {
            OR: [{[field]: {lt: new Date(startOfDay)}}, {[field]: {gte: new Date(startOfNextDay)}}],
          };
        }
        // Exclude exact timestamp if not a date string
        return {NOT: {[field]: new Date(value as string | number | Date)}};
      }
      case 'greaterThan':
        return {[field]: {gt: new Date(value as string | number | Date)}};
      case 'lessThan':
        return {[field]: {lt: new Date(value as string | number | Date)}};
      case 'greaterThanOrEqual':
        return {[field]: {gte: new Date(value as string | number | Date)}};
      case 'lessThanOrEqual':
        return {[field]: {lte: new Date(value as string | number | Date)}};
      case 'within': {
        // "within X days/hours/minutes" means in the past X time units
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "within" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        return {[field]: {gte: since}};
      }
      case 'olderThan': {
        // "olderThan X days/hours/minutes" means more than X time units ago
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "olderThan" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const before = new Date(now.getTime() - milliseconds);

        return {[field]: {lt: before}};
      }
      default:
        throw new HttpException(400, `Unsupported operator for date field: ${operator}`);
    }
  }

  /**
   * Convert time value and unit to milliseconds
   */
  private static getMilliseconds(value: number, unit: 'days' | 'hours' | 'minutes'): number {
    switch (unit) {
      case 'days':
        return value * 24 * 60 * 60 * 1000;
      case 'hours':
        return value * 60 * 60 * 1000;
      case 'minutes':
        return value * 60 * 1000;
      default:
        throw new HttpException(400, `Unsupported time unit: ${unit}`);
    }
  }

  /**
   * Check if a value is a date string in YYYY-MM-DD format
   */
  private static isDateString(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // Match YYYY-MM-DD format (with optional time component)
    const dateRegex = /^\d{4}-\d{2}-\d{2}(T|$)/;
    if (!dateRegex.test(value)) return false;
    // Verify it's a valid date
    const date = new Date(value);
    return !isNaN(date.getTime());
  }

  /**
   * Get date range for a date string (start of day to start of next day in UTC)
   * @param value - Date string in YYYY-MM-DD format
   * @returns Object with startOfDay and startOfNextDay as ISO strings
   */
  private static getDateRange(value: string): {startOfDay: string; startOfNextDay: string} {
    // Extract just the date part (YYYY-MM-DD)
    const dateStr = value.split('T')[0];
    const startOfDay = `${dateStr}T00:00:00.000Z`;

    if (!dateStr) {
      throw new HttpException(400, `Invalid date string: ${value}`);
    }

    // Calculate start of next day
    const nextDay = new Date(dateStr);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const startOfNextDay = nextDay.toISOString().split('T')[0] + 'T00:00:00.000Z';

    return {startOfDay, startOfNextDay};
  }

  /**
   * Build condition for event-based filters
   * Uses Prisma relations to efficiently query contacts who triggered specific events
   */
  private static buildEventCondition(
    eventName: string,
    operator: string,
    value: unknown,
    unit?: 'days' | 'hours' | 'minutes',
  ): Prisma.ContactWhereInput {
    switch (operator) {
      case 'triggered':
        // Contact has triggered this event at any time
        return {
          events: {
            some: {
              name: eventName,
            },
          },
        };

      case 'triggeredWithin': {
        // Contact has triggered this event within the specified timeframe
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "triggeredWithin" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        return {
          events: {
            some: {
              name: eventName,
              createdAt: {
                gte: since,
              },
            },
          },
        };
      }

      case 'triggeredOlderThan': {
        // Contact triggered this event, but only more than X time ago (not recently)
        // This means: has event AND all occurrences are before the cutoff
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "triggeredOlderThan" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const before = new Date(now.getTime() - milliseconds);

        return {
          AND: [
            // Must have triggered the event at some point
            {
              events: {
                some: {
                  name: eventName,
                },
              },
            },
            // But NOT within the recent timeframe
            {
              events: {
                none: {
                  name: eventName,
                  createdAt: {
                    gte: before,
                  },
                },
              },
            },
          ],
        };
      }

      case 'notTriggered':
        // Contact has never triggered this event
        return {
          events: {
            none: {
              name: eventName,
            },
          },
        };

      case 'notTriggeredWithin': {
        // Contact has not triggered this event within the timeframe (includes never-triggered contacts)
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "notTriggeredWithin" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        return {
          events: {
            none: {
              name: eventName,
              createdAt: {
                gte: since,
              },
            },
          },
        };
      }

      default:
        throw new HttpException(400, `Unsupported operator for event field: ${operator}`);
    }
  }

  /**
   * Build condition for email activity filters
   * Uses Prisma relations to efficiently query contacts based on email engagement
   */
  private static buildEmailActivityCondition(
    activity: string,
    operator: string,
    value: unknown,
    unit?: 'days' | 'hours' | 'minutes',
  ): Prisma.ContactWhereInput {
    // Map activity names to Email model fields (accept both verb and past-tense forms)
    const fieldMap: Record<string, string> = {
      open: 'openedAt',
      opened: 'openedAt',
      click: 'clickedAt',
      clicked: 'clickedAt',
      bounce: 'bouncedAt',
      bounced: 'bouncedAt',
      complaint: 'complainedAt',
      complained: 'complainedAt',
      sent: 'sentAt',
      delivery: 'deliveredAt',
      delivered: 'deliveredAt',
    };

    const field = fieldMap[activity];
    if (!field) {
      throw new HttpException(400, `Unsupported email activity: ${activity}`);
    }

    switch (operator) {
      case 'triggered':
        // Contact has this email activity at any time
        return {
          emails: {
            some: {
              [field]: {
                not: null,
              },
            },
          },
        };

      case 'triggeredWithin': {
        // Contact has this email activity within the specified timeframe
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "triggeredWithin" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        return {
          emails: {
            some: {
              [field]: {
                gte: since,
              },
            },
          },
        };
      }

      case 'triggeredOlderThan': {
        // Contact had this email activity, but only more than X time ago (not recently)
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "triggeredOlderThan" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const before = new Date(now.getTime() - milliseconds);

        return {
          AND: [
            // Must have the email activity at some point
            {
              emails: {
                some: {
                  [field]: {
                    not: null,
                  },
                },
              },
            },
            // But NOT within the recent timeframe
            {
              emails: {
                none: {
                  [field]: {
                    gte: before,
                  },
                },
              },
            },
          ],
        };
      }

      case 'notTriggered':
        // Contact has never had this email activity
        return {
          emails: {
            none: {
              [field]: {
                not: null,
              },
            },
          },
        };

      case 'notTriggeredWithin': {
        // Contact has not had this email activity within the timeframe (includes contacts with no activity)
        if (!unit) {
          throw new HttpException(400, 'Unit is required for "notTriggeredWithin" operator');
        }

        const now = new Date();
        const milliseconds = this.getMilliseconds(value as number, unit);
        const since = new Date(now.getTime() - milliseconds);

        return {
          emails: {
            none: {
              [field]: {
                gte: since,
              },
            },
          },
        };
      }

      default:
        throw new HttpException(400, `Unsupported operator for email activity field: ${operator}`);
    }
  }
}
