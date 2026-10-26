import type {Prisma} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ContactSegmentsService, type DynamicSegment} from '../ContactSegmentsService.js';

describe('ContactSegmentsService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  async function staticSegment(name: string, project = projectId) {
    return prisma.segment.create({data: {projectId: project, name, type: 'STATIC'}});
  }

  describe('forContact', () => {
    it("lists the contact's current static segments and the dynamic ones it matches, by name", async () => {
      const contact = await factories.createContact({projectId, data: {plan: 'pro'}});
      const workshop = await staticSegment('Workshop');
      const alumni = await staticSegment('Alumni');
      const left = await staticSegment('Beta testers');
      await prisma.segmentMembership.createMany({
        data: [
          {segmentId: workshop.id, contactId: contact.id},
          {segmentId: alumni.id, contactId: contact.id},
          {segmentId: left.id, contactId: contact.id, exitedAt: new Date()},
        ],
      });
      const pro = await factories.createSegment(projectId, {
        name: 'Pro plan',
        filters: [{field: 'data.plan', operator: 'equals', value: 'pro'}],
      });
      await factories.createSegment(projectId, {
        name: 'Free plan',
        filters: [{field: 'data.plan', operator: 'equals', value: 'free'}],
      });

      const segments = await ContactSegmentsService.forContact(projectId, contact.id);

      expect(segments).toEqual({
        static: [
          {id: alumni.id, name: 'Alumni'},
          {id: workshop.id, name: 'Workshop'},
        ],
        dynamic: [{id: pro.id, name: 'Pro plan'}],
      });
    });

    it("ignores another project's segments, even ones holding a membership row for the contact", async () => {
      const contact = await factories.createContact({projectId});
      const {project: other} = await factories.createUserWithProject();
      const foreign = await staticSegment('Theirs', other.id);
      await prisma.segmentMembership.create({data: {segmentId: foreign.id, contactId: contact.id}});
      await factories.createSegment(other.id, {
        name: 'Everyone there',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
      });

      expect(await ContactSegmentsService.forContact(projectId, contact.id)).toEqual({static: [], dynamic: []});
    });

    it('leaves out a dynamic segment whose filter cannot be built', async () => {
      const contact = await factories.createContact({projectId});
      await prisma.segment.create({data: {projectId, name: 'Broken', type: 'DYNAMIC', condition: {nonsense: true}}});

      expect(await ContactSegmentsService.forContact(projectId, contact.id)).toEqual({static: [], dynamic: []});
    });
  });

  describe('dynamicSegmentsOf', () => {
    it("drops a filter that fails to run from the caller's list, so later batches skip it", async () => {
      const contact = await factories.createContact({projectId});
      const segments: DynamicSegment[] = [
        {id: 'everyone', name: 'Everyone', where: {}},
        // An operator Prisma rejects when the query runs, not when the filter is built
        {id: 'broken', name: 'Broken', where: {email: {notAnOperator: true}} as unknown as Prisma.ContactWhereInput},
      ];

      const first = await ContactSegmentsService.dynamicSegmentsOf(projectId, [contact.id], segments);

      expect(first.get(contact.id)).toEqual([{id: 'everyone', name: 'Everyone'}]);
      expect(segments.map(s => s.id)).toEqual(['everyone']);
    });
  });
});
