import type {BulkContactActionJobData, BulkContactActionResult, SegmentEventKind} from '@plunk/types';
import type {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';
import {QueueService} from '../../services/QueueService';
import {processBulkContactAction} from '../bulk-contact-processor.js';

describe('processBulkContactAction - static segments', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let segmentId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const segment = await prisma.segment.create({
      data: {projectId, name: 'Workshop', type: 'STATIC', trackMembership: true},
    });
    segmentId = segment.id;
    vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({} as Job);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A job whose `updateData` persists, as BullMQ's does, so a retry sees the saved progress */
  function jobFor(data: BulkContactActionJobData): Job<BulkContactActionJobData> {
    const job = createMockJob(data);
    return Object.assign(job, {
      updateData: vi.fn(async (next: BulkContactActionJobData) => {
        job.data = next;
      }),
    });
  }

  async function members() {
    const rows = await prisma.segmentMembership.findMany({where: {segmentId, exitedAt: null}});
    return rows.map(m => m.contactId).sort();
  }

  /** Contacts whose entry or exit events were queued, in all calls */
  function queuedEvents(kind: SegmentEventKind) {
    return vi
      .mocked(QueueService.queueSegmentMembershipEvents)
      .mock.calls.filter(([data]) => data.kind === kind)
      .flatMap(([data]) => data.contactIds)
      .sort();
  }

  async function addMembers(contactIds: string[]) {
    await prisma.segmentMembership.createMany({data: contactIds.map(contactId => ({segmentId, contactId}))});
    await prisma.segment.update({where: {id: segmentId}, data: {memberCount: contactIds.length}});
  }

  it('adds every matching contact in query mode, minus the unticked ones, and queues their entries', async () => {
    const [a, b, c] = await factories.createContacts(projectId, 3);
    await addMembers([c!.id]);

    const result = await processBulkContactAction(
      jobFor({
        projectId,
        operation: 'addToSegment',
        targetSegmentId: segmentId,
        selector: {mode: 'query', filter: {}, excludeIds: [b!.id]},
      }),
    );

    // c was already a member: it re-enters, so it counts and its entry is queued again
    expect(result).toMatchObject({totalRequested: 2, successCount: 2, unchangedCount: 0, failureCount: 0});
    expect(await members()).toEqual([a!.id, c!.id].sort());
    expect(queuedEvents('entry')).toEqual([a!.id, c!.id].sort());
  });

  it('counts non-members as unchanged and contacts of other projects as failed when removing', async () => {
    const [a, b, outsider] = await factories.createContacts(projectId, 3);
    const {project: other} = await factories.createUserWithProject();
    const foreign = await factories.createContact({projectId: other.id});
    await addMembers([a!.id, b!.id]);

    const result = await processBulkContactAction(
      jobFor({
        projectId,
        operation: 'removeFromSegment',
        targetSegmentId: segmentId,
        selector: {mode: 'ids', contactIds: [a!.id, b!.id, outsider!.id, foreign.id]},
      }),
    );

    expect(result).toMatchObject({totalRequested: 4, successCount: 2, unchangedCount: 1, failureCount: 1});
    expect(await members()).toEqual([]);
    expect(queuedEvents('exit')).toEqual([a!.id, b!.id].sort());
    expect((await prisma.segment.findUniqueOrThrow({where: {id: segmentId}})).memberCount).toBe(0);
  });

  it('removes everyone in the segment when the list is filtered by that same segment', async () => {
    const contacts = await factories.createContacts(projectId, 120);
    await addMembers(contacts.map(c => c.id));

    const result = await processBulkContactAction(
      jobFor({
        projectId,
        operation: 'removeFromSegment',
        targetSegmentId: segmentId,
        selector: {mode: 'query', filter: {segmentId}},
      }),
    );

    expect(result).toMatchObject({totalRequested: 120, successCount: 120, failureCount: 0});
    expect(await members()).toEqual([]);
  });

  it('saves its progress after each batch and resumes from it without re-firing entries', async () => {
    const contacts = await factories.createContacts(projectId, 150);
    const ids = contacts.map(c => c.id);
    const done: BulkContactActionResult = {
      operation: 'addToSegment',
      totalRequested: 150,
      successCount: 100,
      unchangedCount: 0,
      failureCount: 0,
      errors: [],
    };
    const job = jobFor({
      projectId,
      operation: 'addToSegment',
      targetSegmentId: segmentId,
      selector: {mode: 'ids', contactIds: ids},
      resume: {next: 100, processed: 100, result: done},
    });

    const result = await processBulkContactAction(job);

    expect(result).toMatchObject({totalRequested: 150, successCount: 150});
    expect(queuedEvents('entry')).toEqual(ids.slice(100).sort());
    expect(job.updateData).toHaveBeenCalledTimes(1);
    expect(job.data).toMatchObject({resume: {next: 150, processed: 150}});
  });

  it('skips an unticked contact past the first batch while paging by id', async () => {
    const contacts = await factories.createContacts(projectId, 150);
    const desc = contacts
      .map(c => c.id)
      .sort()
      .reverse();
    const unticked = desc[120]!;

    const result = await processBulkContactAction(
      jobFor({
        projectId,
        operation: 'addToSegment',
        targetSegmentId: segmentId,
        selector: {mode: 'query', filter: {}, excludeIds: [unticked]},
      }),
    );

    expect(result).toMatchObject({totalRequested: 149, successCount: 149});
    expect(queuedEvents('entry')).toEqual(desc.filter(id => id !== unticked).sort());
  });

  it('resumes a query-mode job after the last contact id it handled', async () => {
    const contacts = await factories.createContacts(projectId, 5);
    const desc = contacts
      .map(c => c.id)
      .sort()
      .reverse();
    const job = jobFor({
      projectId,
      operation: 'addToSegment',
      targetSegmentId: segmentId,
      selector: {mode: 'query', filter: {}},
      resume: {
        next: desc[1]!,
        processed: 2,
        result: {
          operation: 'addToSegment',
          totalRequested: 5,
          successCount: 2,
          unchangedCount: 0,
          failureCount: 0,
          errors: [],
        },
      },
    });

    const result = await processBulkContactAction(job);

    expect(result).toMatchObject({totalRequested: 5, successCount: 5});
    expect(queuedEvents('entry')).toEqual(desc.slice(2).sort());
  });

  it('fails the job when the segment is no longer static', async () => {
    const [contact] = await factories.createContacts(projectId, 1);
    await prisma.segment.update({where: {id: segmentId}, data: {type: 'DYNAMIC'}});

    await expect(
      processBulkContactAction(
        jobFor({
          projectId,
          operation: 'addToSegment',
          targetSegmentId: segmentId,
          selector: {mode: 'ids', contactIds: [contact!.id]},
        }),
      ),
    ).rejects.toThrow('Can only add contacts to STATIC segments');
  });

  it('leaves the other operations without saved progress', async () => {
    const [contact] = await factories.createContacts(projectId, 1, {subscribed: false});
    const job = jobFor({projectId, operation: 'subscribe', selector: {mode: 'ids', contactIds: [contact!.id]}});

    const result = await processBulkContactAction(job);

    expect(result).toMatchObject({successCount: 1});
    expect(job.updateData).not.toHaveBeenCalled();
  });
});
