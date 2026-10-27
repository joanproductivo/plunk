import {WorkflowTriggerType} from '@plunk/db';
import type {SegmentMembershipEventsJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EventService} from '../EventService';
import {QueueService} from '../QueueService';
import {SegmentMembershipService} from '../SegmentMembershipService';
import {SegmentService} from '../SegmentService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

describe('SegmentMembershipService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createStaticSegment(trackMembership = true, name = 'Workshop') {
    return prisma.segment.create({data: {projectId, name, type: 'STATIC', trackMembership}});
  }

  async function addMembership(segmentId: string, contactId: string, exitedAt: Date | null = null) {
    const enteredAt = new Date('2026-01-01T00:00:00Z');
    await prisma.segmentMembership.create({data: {segmentId, contactId, enteredAt, exitedAt}});
    if (exitedAt === null) {
      await prisma.segment.update({where: {id: segmentId}, data: {memberCount: {increment: 1}}});
    }
    return enteredAt;
  }

  function eventContactIds(name: string) {
    return prisma.event
      .findMany({where: {projectId, name}, orderBy: {createdAt: 'asc'}})
      .then(events => events.map(e => e.contactId));
  }

  async function enteredAtOf(segmentId: string, contactId: string) {
    const membership = await prisma.segmentMembership.findUniqueOrThrow({
      where: {contactId_segmentId: {contactId, segmentId}},
    });
    return membership.enteredAt.getTime();
  }

  async function memberCountOf(segmentId: string) {
    const segment = await prisma.segment.findUniqueOrThrow({where: {id: segmentId}});
    return segment.memberCount;
  }

  describe('addMembers', () => {
    it('treats members who are already in the segment as new entries outside silent mode', async () => {
      const segment = await createStaticSegment();
      const [fresh1, fresh2, active, returning] = await factories.createContacts(projectId, 4);
      const activeEnteredAt = await addMembership(segment.id, active!.id);
      await addMembership(segment.id, returning!.id, new Date('2026-02-01T00:00:00Z'));

      const ids = [fresh1!.id, fresh2!.id, active!.id, returning!.id];
      const result = await SegmentMembershipService.addMembers(projectId, segment.id, ids, {mode: 'await'});

      expect(result).toEqual({added: 4});
      expect((await eventContactIds('segment.workshop.entry')).sort()).toEqual([...ids].sort());
      const [event] = await prisma.event.findMany({where: {projectId, name: 'segment.workshop.entry'}, take: 1});
      expect(event?.data).toEqual({segmentId: segment.id, segmentName: 'Workshop'});

      expect(await enteredAtOf(segment.id, active!.id)).toBeGreaterThan(activeEnteredAt.getTime());
      expect(await memberCountOf(segment.id)).toBe(4);
    });

    it('leaves members alone and fires nothing in silent mode', async () => {
      const segment = await createStaticSegment();
      const [fresh1, fresh2, active, returning] = await factories.createContacts(projectId, 4);
      const activeEnteredAt = await addMembership(segment.id, active!.id);
      await addMembership(segment.id, returning!.id, new Date('2026-02-01T00:00:00Z'));

      const result = await SegmentMembershipService.addMembers(
        projectId,
        segment.id,
        [fresh1!.id, fresh2!.id, active!.id, returning!.id],
        {mode: 'silent'},
      );

      expect(result).toEqual({added: 3});
      expect(await eventContactIds('segment.workshop.entry')).toEqual([]);
      expect(await enteredAtOf(segment.id, active!.id)).toBe(activeEnteredAt.getTime());
      expect(await prisma.segmentMembership.count({where: {segmentId: segment.id, exitedAt: null}})).toBe(4);
      expect(await memberCountOf(segment.id)).toBe(4);
    });

    it('queues entry events in background mode instead of firing them', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});
      const queue = vi
        .spyOn(QueueService, 'queueSegmentMembershipEvents')
        .mockResolvedValue({} as Job<SegmentMembershipEventsJobData>);

      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {
        mode: 'background',
      });

      expect(result).toEqual({added: 1});
      expect(queue).toHaveBeenCalledWith({
        projectId,
        segmentId: segment.id,
        segmentName: 'Workshop',
        kind: 'entry',
        contactIds: [contact.id],
      });
      expect(await eventContactIds('segment.workshop.entry')).toEqual([]);
    });

    it('keeps the membership when the events cannot be queued', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});
      vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockRejectedValue(new Error('redis down'));

      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {
        mode: 'background',
      });

      expect(result).toEqual({added: 1});
      expect(await memberCountOf(segment.id)).toBe(1);
    });

    it('stops waiting for a queue that does not answer', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});
      // Redis down: BullMQ's add waits rather than failing
      vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockReturnValue(
        new Promise<Job<SegmentMembershipEventsJobData>>(() => {}),
      );

      const started = Date.now();
      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {
        mode: 'background',
      });

      expect(result).toEqual({added: 1});
      expect(Date.now() - started).toBeLessThan(4500);
    });

    it('counts repeated ids once and handles an empty list', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});

      expect(await SegmentMembershipService.addMembers(projectId, segment.id, [], {mode: 'await'})).toEqual({
        added: 0,
      });
      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id, contact.id], {
        mode: 'await',
      });

      expect(result).toEqual({added: 1});
      expect(await eventContactIds('segment.workshop.entry')).toEqual([contact.id]);
      expect(await memberCountOf(segment.id)).toBe(1);
    });

    it('fires no events when the segment does not track membership', async () => {
      const segment = await createStaticSegment(false);
      const contact = await factories.createContact({projectId});

      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {mode: 'await'});

      expect(result).toEqual({added: 1});
      expect(await prisma.event.count({where: {projectId}})).toBe(0);
    });

    it('ignores contacts from another project', async () => {
      const segment = await createStaticSegment();
      const {project: otherProject} = await factories.createUserWithProject();
      const foreign = await factories.createContact({projectId: otherProject.id});

      const result = await SegmentMembershipService.addMembers(projectId, segment.id, [foreign.id], {mode: 'await'});

      expect(result).toEqual({added: 0});
      expect(await prisma.segmentMembership.count({where: {segmentId: segment.id}})).toBe(0);
      expect(await prisma.event.count({where: {contactId: foreign.id}})).toBe(0);
    });

    it('rejects dynamic segments and segments of another project', async () => {
      const contact = await factories.createContact({projectId});
      const dynamic = await factories.createSegment(projectId, {
        name: 'Dynamic',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
      });
      const {project: otherProject} = await factories.createUserWithProject();
      const foreignSegment = await prisma.segment.create({
        data: {projectId: otherProject.id, name: 'Foreign', type: 'STATIC'},
      });

      await expect(
        SegmentMembershipService.addMembers(projectId, dynamic.id, [contact.id], {mode: 'await'}),
      ).rejects.toThrow('Can only add contacts to STATIC segments');
      await expect(
        SegmentMembershipService.addMembers(projectId, foreignSegment.id, [contact.id], {mode: 'await'}),
      ).rejects.toThrow('Segment not found');
    });
  });

  describe('removeMembers', () => {
    it('removes only members and fires exit for them', async () => {
      const segment = await createStaticSegment();
      const [member, outsider] = await factories.createContacts(projectId, 2);
      await addMembership(segment.id, member!.id);

      const result = await SegmentMembershipService.removeMembers(projectId, segment.id, [member!.id, outsider!.id], {
        mode: 'await',
      });

      expect(result).toEqual({removed: 1, matched: 2});
      expect(await eventContactIds('segment.workshop.exit')).toEqual([member!.id]);
      expect(await memberCountOf(segment.id)).toBe(0);
    });

    it('queues exit events in background mode', async () => {
      const segment = await createStaticSegment();
      const member = await factories.createContact({projectId});
      await addMembership(segment.id, member.id);
      const queue = vi
        .spyOn(QueueService, 'queueSegmentMembershipEvents')
        .mockResolvedValue({} as Job<SegmentMembershipEventsJobData>);

      await SegmentMembershipService.removeMembers(projectId, segment.id, [member.id], {mode: 'background'});

      expect(queue).toHaveBeenCalledWith(expect.objectContaining({kind: 'exit', contactIds: [member.id]}));
    });

    it('does not count or fire twice for a contact removed twice', async () => {
      const segment = await createStaticSegment();
      const member = await factories.createContact({projectId});
      await addMembership(segment.id, member.id);

      await SegmentMembershipService.removeMembers(projectId, segment.id, [member.id], {mode: 'await'});
      const again = await SegmentMembershipService.removeMembers(projectId, segment.id, [member.id], {mode: 'await'});

      expect(again).toEqual({removed: 0, matched: 1});
      expect(await eventContactIds('segment.workshop.exit')).toEqual([member.id]);
      expect(await memberCountOf(segment.id)).toBe(0);
    });
  });

  describe('workflows triggered by entry', () => {
    async function createEntryWorkflow(allowReentry: boolean) {
      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        allowReentry,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'segment.workshop.entry'},
      });
      await EventService.invalidateWorkflowCache(projectId);
      return workflow;
    }

    it('runs the workflow again when a member is re-added and re-entry is allowed', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});
      const workflow = await createEntryWorkflow(true);

      await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {mode: 'await'});
      const [first] = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(first?.status).toBe('COMPLETED');

      await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {mode: 'await'});

      const executions = await prisma.workflowExecution.count({
        where: {workflowId: workflow.id, contactId: contact.id},
      });
      expect(executions).toBe(2);
    });

    it('runs the workflow once when re-entry is not allowed', async () => {
      const segment = await createStaticSegment();
      const contact = await factories.createContact({projectId});
      const workflow = await createEntryWorkflow(false);

      await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {mode: 'await'});
      await SegmentMembershipService.addMembers(projectId, segment.id, [contact.id], {mode: 'await'});

      const executions = await prisma.workflowExecution.count({
        where: {workflowId: workflow.id, contactId: contact.id},
      });
      expect(executions).toBe(1);
    });
  });

  describe('SegmentService email wrappers', () => {
    it('addContacts re-enters members and reports every matched contact as added', async () => {
      const segment = await createStaticSegment(false);
      const contact = await factories.createContact({projectId, email: 'member@example.com'});
      await addMembership(segment.id, contact.id);

      const result = await SegmentService.addContacts(projectId, segment.id, ['member@example.com']);

      expect(result).toEqual({added: 1, created: 0, notFound: []});
      expect(await memberCountOf(segment.id)).toBe(1);
    });

    it('removeContacts matches normalized emails and counts only former members', async () => {
      const segment = await createStaticSegment(false);
      const [member, outsider] = await Promise.all([
        factories.createContact({projectId, email: 'member@example.com'}),
        factories.createContact({projectId, email: 'outsider@example.com'}),
      ]);
      await addMembership(segment.id, member.id);

      const result = await SegmentService.removeContacts(projectId, segment.id, [
        ' MEMBER@example.com ',
        outsider.email,
      ]);

      expect(result).toEqual({removed: 1});
      expect(await memberCountOf(segment.id)).toBe(0);
    });
  });

  describe('SegmentService.computeMembership (shared event loop)', () => {
    it('fires entry and exit events for a tracked dynamic segment', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      const segment = await factories.createSegment(projectId, {
        name: 'Active Readers',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
        trackMembership: true,
      });

      await SegmentService.computeMembership(projectId, segment.id);
      expect(await eventContactIds('segment.active-readers.entry')).toEqual([contact.id]);
      const [entry] = await prisma.event.findMany({where: {projectId, name: 'segment.active-readers.entry'}});
      expect(entry?.data).toEqual({segmentId: segment.id, segmentName: 'Active Readers'});

      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: false}});
      await SegmentService.computeMembership(projectId, segment.id);
      expect(await eventContactIds('segment.active-readers.exit')).toEqual([contact.id]);
    });

    it('enters each contact once when two computations run at once (Plunk Lite)', async () => {
      const contacts = await Promise.all([1, 2, 3].map(() => factories.createContact({projectId, subscribed: true})));
      const segment = await factories.createSegment(projectId, {
        name: 'Readers',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
        trackMembership: true,
      });

      const [first, second] = await Promise.all([
        SegmentService.computeMembership(projectId, segment.id),
        SegmentService.computeMembership(projectId, segment.id),
      ]);

      expect(first.added + second.added).toBe(3);
      expect(await eventContactIds('segment.readers.entry')).toEqual(contacts.map(c => c.id).sort());
      expect(await memberCountOf(segment.id)).toBe(3);
    });

    it('queues the events instead of firing them when a request computes (Plunk Lite)', async () => {
      const queued = vi.spyOn(QueueService, 'queueSegmentMembershipEvents').mockResolvedValue({id: 'job'} as never);
      const contact = await factories.createContact({projectId, subscribed: true});
      const segment = await factories.createSegment(projectId, {
        name: 'Queued',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
        trackMembership: true,
      });

      await SegmentService.computeMembership(projectId, segment.id, {events: 'background'});

      expect(queued).toHaveBeenCalledWith(expect.objectContaining({kind: 'entry', contactIds: [contact.id]}));
      expect(await eventContactIds('segment.queued.entry')).toEqual([]);
      // A second computation with nothing changed queues nothing
      await SegmentService.computeMembership(projectId, segment.id, {events: 'background'});
      expect(queued).toHaveBeenCalledTimes(1);
    });
  });
});
