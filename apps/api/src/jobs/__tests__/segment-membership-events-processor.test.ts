import type {ContactSubscriptionEventsJobData, SegmentEventKind, SegmentMembershipEventsJobData} from '@plunk/types';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';
import {processSegmentMembershipEvents} from '../segment-membership-events-processor.js';

describe('processSegmentMembershipEvents', () => {
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
  });

  function jobFor(contactIds: string[], kind: SegmentEventKind = 'entry', progress?: number) {
    const job = createMockJob<SegmentMembershipEventsJobData>({
      projectId,
      segmentId,
      segmentName: 'Workshop',
      kind,
      contactIds,
    });
    return Object.assign(job, {progress: progress ?? 0});
  }

  async function events(name: string) {
    const rows = await prisma.event.findMany({where: {projectId, name}});
    return rows.map(e => e.contactId).sort();
  }

  it("tracks each contact's event under the segment's name and records progress", async () => {
    const contacts = await factories.createContacts(projectId, 3);
    const ids = contacts.map(c => c.id);
    const job = jobFor(ids);

    await processSegmentMembershipEvents(job);

    expect(await events('segment.workshop.entry')).toEqual([...ids].sort());
    const [event] = await prisma.event.findMany({where: {projectId}, take: 1});
    expect(event?.data).toEqual({segmentId, segmentName: 'Workshop'});
    expect(job.updateProgress).toHaveBeenNthCalledWith(1, 1);
    expect(job.updateProgress).toHaveBeenLastCalledWith(3);
  });

  it('resumes after the contacts a previous run already handled', async () => {
    const contacts = await factories.createContacts(projectId, 3);
    const ids = contacts.map(c => c.id);
    const job = jobFor(ids, 'exit', 2);

    await processSegmentMembershipEvents(job);

    expect(await events('segment.workshop.exit')).toEqual([ids[2]]);
    expect(job.updateProgress).toHaveBeenCalledTimes(1);
    expect(job.updateProgress).toHaveBeenCalledWith(3);
  });

  it('stops, so the job is retried from its progress, when progress cannot be saved', async () => {
    const contacts = await factories.createContacts(projectId, 3);
    const ids = contacts.map(c => c.id);
    const job = jobFor(ids);
    vi.mocked(job.updateProgress).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('redis error'));

    await expect(processSegmentMembershipEvents(job)).rejects.toThrow('redis error');

    expect(await events('segment.workshop.entry')).toEqual([ids[0], ids[1]].sort());
  });

  it('fires nothing for a segment deleted or no longer tracked', async () => {
    const contact = await factories.createContact({projectId});
    await prisma.segment.update({where: {id: segmentId}, data: {trackMembership: false}});

    await processSegmentMembershipEvents(jobFor([contact.id]));

    expect(await events('segment.workshop.entry')).toEqual([]);
  });

  it('counts a contact whose event failed as handled', async () => {
    const contact = await factories.createContact({projectId});
    // An event for a contact that does not exist fails on its foreign key
    const job = jobFor([contact.id, '00000000-0000-4000-8000-000000000000']);

    await processSegmentMembershipEvents(job);

    expect(await events('segment.workshop.entry')).toEqual([contact.id]);
    expect(job.updateProgress).toHaveBeenLastCalledWith(2);
  });

  describe('the events of a bulk subscription change (Plunk Lite)', () => {
    function subscriptionJob(contactIds: string[], progress = 0) {
      const job = createMockJob<ContactSubscriptionEventsJobData>({
        type: 'contact-subscription',
        projectId,
        eventName: 'contact.subscribed',
        contactIds,
      });
      return Object.assign(job, {progress});
    }

    it('tracks the event for each contact, with progress', async () => {
      const ids = (await factories.createContacts(projectId, 3)).map(c => c.id);
      const job = subscriptionJob(ids);

      await processSegmentMembershipEvents(job);

      expect(await events('contact.subscribed')).toEqual([...ids].sort());
      expect(job.updateProgress).toHaveBeenLastCalledWith(3);
    });

    it('resumes after the contacts a previous run already handled', async () => {
      const ids = (await factories.createContacts(projectId, 3)).map(c => c.id);

      await processSegmentMembershipEvents(subscriptionJob(ids, 2));

      expect(await events('contact.subscribed')).toEqual([ids[2]]);
    });
  });
});

