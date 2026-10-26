import {WorkflowExecutionStatus, WorkflowStepType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {EventService} from '../EventService';
import {SegmentMembershipService} from '../SegmentMembershipService';
import {SegmentService} from '../SegmentService';
import {WorkflowService} from '../WorkflowService';

/**
 * Segments in workflows: an Update contact step that removes from and adds to static segments,
 * a Condition on `segment.<id>`, and the guard against deleting a segment a step uses.
 */
describe('Workflow segment actions', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function staticSegment(name: string, trackMembership = true) {
    return prisma.segment.create({data: {projectId, name, type: 'STATIC', trackMembership}});
  }

  async function join(segmentId: string, contactId: string) {
    await prisma.segmentMembership.create({data: {segmentId, contactId}});
    await prisma.segment.update({where: {id: segmentId}, data: {memberCount: {increment: 1}}});
  }

  type StepSpec = {key: string; type: WorkflowStepType; config: unknown};

  /**
   * An enabled workflow started by `eventName`: its trigger, then `steps`, wired by `edges`
   * (`[from, to, branch?]`; 'trigger' is the trigger step).
   */
  async function workflow(
    name: string,
    eventName: string,
    steps: StepSpec[],
    edges: Array<[string, string, string?]>,
    {allowReentry = false} = {},
  ) {
    const created = await factories.createWorkflow({
      projectId,
      name,
      enabled: true,
      allowReentry,
      triggerConfig: {eventName},
    });
    const trigger = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: created.id, type: WorkflowStepType.TRIGGER},
    });
    await prisma.workflowStep.update({where: {id: trigger.id}, data: {config: toPrismaJson({eventName})}});

    const ids = new Map<string, string>([['trigger', trigger.id]]);
    for (const [i, step] of steps.entries()) {
      const row = await prisma.workflowStep.create({
        data: {
          workflowId: created.id,
          type: step.type,
          name: step.key,
          position: {x: (i + 1) * 100, y: 0},
          config: toPrismaJson(step.config),
        },
      });
      ids.set(step.key, row.id);
    }
    for (const [from, to, branch] of edges) {
      await prisma.workflowTransition.create({
        data: {
          fromStepId: ids.get(from)!,
          toStepId: ids.get(to)!,
          ...(branch ? {condition: toPrismaJson({branch})} : {}),
        },
      });
    }
    return {workflow: created, stepId: (key: string) => ids.get(key)!};
  }

  /** The step's output for each contact that ran it */
  async function outputsOf(stepId: string) {
    const executions = await prisma.workflowStepExecution.findMany({
      where: {stepId},
      select: {output: true, execution: {select: {contactId: true}}},
    });
    return new Map(executions.map(e => [e.execution.contactId, e.output as Record<string, unknown>]));
  }

  async function events(contactId: string, name: string) {
    return prisma.event.findMany({where: {projectId, contactId, name}});
  }

  describe('Update contact step', () => {
    it('moves a contact from one segment to another, and the workflow it starts sees the new data', async () => {
      const contact = await factories.createContact({projectId});
      const a = await staticSegment('A');
      const b = await staticSegment('B');
      await join(a.id, contact.id);

      const mover = await workflow(
        'Mover',
        'test.start',
        [
          {
            key: 'move',
            type: WorkflowStepType.UPDATE_CONTACT,
            config: {updates: {stage: 'moved'}, segments: {remove: [a.id], add: [b.id]}},
          },
        ],
        [['trigger', 'move']],
      );
      const follower = await workflow(
        'Follower',
        'segment.b.entry',
        [
          {
            key: 'check',
            type: WorkflowStepType.CONDITION,
            config: {field: 'data.stage', operator: 'equals', value: 'moved'},
          },
          {key: 'saw', type: WorkflowStepType.EXIT, config: {reason: 'saw'}},
          {key: 'missed', type: WorkflowStepType.EXIT, config: {reason: 'missed'}},
        ],
        [
          ['trigger', 'check'],
          ['check', 'saw', 'yes'],
          ['check', 'missed', 'no'],
        ],
      );

      await EventService.trackEvent(projectId, 'test.start', contact.id);

      const memberships = await prisma.segmentMembership.findMany({where: {contactId: contact.id}});
      expect(memberships.find(m => m.segmentId === a.id)?.exitedAt).not.toBeNull();
      expect(memberships.find(m => m.segmentId === b.id)?.exitedAt).toBeNull();
      // Exit before entry (timestamps can tie at millisecond precision, hence <=)
      const [exit] = await events(contact.id, 'segment.a.exit');
      const [entry] = await events(contact.id, 'segment.b.entry');
      expect(exit!.createdAt.getTime()).toBeLessThanOrEqual(entry!.createdAt.getTime());
      expect((await outputsOf(mover.stepId('move'))).get(contact.id)).toMatchObject({
        segmentsRemoved: [a.id],
        segmentsAdded: [b.id],
        skippedSegments: [],
      });
      expect((await outputsOf(follower.stepId('check'))).get(contact.id)).toMatchObject({branch: 'yes'});
    });

    it('re-adds a current member as a new entry, starting the workflow again when it allows re-entry', async () => {
      const contact = await factories.createContact({projectId});
      const b = await staticSegment('B');
      await join(b.id, contact.id);
      await workflow(
        'Adder',
        'test.start',
        [{key: 'add', type: WorkflowStepType.UPDATE_CONTACT, config: {segments: {add: [b.id]}}}],
        [['trigger', 'add']],
      );
      const follower = await workflow(
        'Follower',
        'segment.b.entry',
        [{key: 'done', type: WorkflowStepType.EXIT, config: {}}],
        [['trigger', 'done']],
        {allowReentry: true},
      );
      await factories.createWorkflowExecution(follower.workflow.id, contact.id, {
        status: WorkflowExecutionStatus.COMPLETED,
      });

      await EventService.trackEvent(projectId, 'test.start', contact.id);

      expect(await prisma.workflowExecution.count({where: {workflowId: follower.workflow.id}})).toBe(2);
      expect(await events(contact.id, 'segment.b.entry')).toHaveLength(1);
    });

    it("skips deleted, dynamic and other projects' segments, and adds a repeated one once", async () => {
      const contact = await factories.createContact({projectId});
      const kept = await staticSegment('Kept');
      const dynamic = await factories.createSegment(projectId, {
        name: 'Dynamic',
        filters: [{field: 'subscribed', operator: 'equals', value: true}],
      });
      const {project: other} = await factories.createUserWithProject();
      const foreign = await prisma.segment.create({data: {projectId: other.id, name: 'Theirs', type: 'STATIC'}});
      const deletedId = '00000000-0000-4000-8000-000000000001';
      const flow = await workflow(
        'Adder',
        'test.start',
        [
          {
            key: 'add',
            type: WorkflowStepType.UPDATE_CONTACT,
            config: {segments: {remove: [foreign.id], add: [deletedId, dynamic.id, kept.id, kept.id]}},
          },
        ],
        [['trigger', 'add']],
      );

      await EventService.trackEvent(projectId, 'test.start', contact.id);

      expect((await outputsOf(flow.stepId('add'))).get(contact.id)).toMatchObject({
        updated: true,
        segmentsAdded: [kept.id],
        segmentsRemoved: [],
        skippedSegments: [foreign.id, deletedId, dynamic.id],
      });
      expect(await events(contact.id, 'segment.kept.entry')).toHaveLength(1);
      const execution = await prisma.workflowExecution.findFirstOrThrow({where: {workflowId: flow.workflow.id}});
      expect(execution.status).toBe(WorkflowExecutionStatus.COMPLETED);
    });

    it('fails the step on a database error instead of skipping the segment', async () => {
      const contact = await factories.createContact({projectId});
      const b = await staticSegment('B');
      const flow = await workflow(
        'Adder',
        'test.start',
        [{key: 'add', type: WorkflowStepType.UPDATE_CONTACT, config: {segments: {add: [b.id]}}}],
        [['trigger', 'add']],
      );
      vi.spyOn(SegmentMembershipService, 'addMembers').mockRejectedValueOnce(new Error('connection lost'));

      await EventService.trackEvent(projectId, 'test.start', contact.id);

      const execution = await prisma.workflowExecution.findFirstOrThrow({where: {workflowId: flow.workflow.id}});
      expect(execution.status).toBe(WorkflowExecutionStatus.FAILED);
    });
  });

  describe('Condition on segment membership', () => {
    it('takes the yes branch for a member and the no branch for anyone else', async () => {
      const member = await factories.createContact({projectId});
      const outsider = await factories.createContact({projectId});
      const vip = await staticSegment('VIP', false);
      await join(vip.id, member.id);
      const flow = await workflow(
        'Router',
        'test.start',
        [
          {
            key: 'check',
            type: WorkflowStepType.CONDITION,
            config: {field: `segment.${vip.id}`, operator: 'equals', value: true},
          },
        ],
        [['trigger', 'check']],
      );

      await EventService.trackEvent(projectId, 'test.start', member.id);
      await EventService.trackEvent(projectId, 'test.start', outsider.id);

      const outputs = await outputsOf(flow.stepId('check'));
      expect(outputs.get(member.id)).toMatchObject({actualValue: true, branch: 'yes'});
      expect(outputs.get(outsider.id)).toMatchObject({actualValue: false, branch: 'no'});
    });
  });

  describe('SegmentService.isMember', () => {
    it('reads static membership, and evaluates dynamic filters live', async () => {
      const contact = await factories.createContact({projectId, data: {plan: 'pro'}});
      const current = await staticSegment('Current', false);
      const left = await staticSegment('Left', false);
      await join(current.id, contact.id);
      await prisma.segmentMembership.create({data: {segmentId: left.id, contactId: contact.id, exitedAt: new Date()}});
      const pro = await factories.createSegment(projectId, {
        name: 'Pro',
        filters: [{field: 'data.plan', operator: 'equals', value: 'pro'}],
      });
      const free = await factories.createSegment(projectId, {
        name: 'Free',
        filters: [{field: 'data.plan', operator: 'equals', value: 'free'}],
      });

      expect(await SegmentService.isMember(projectId, current.id, contact.id)).toBe(true);
      expect(await SegmentService.isMember(projectId, left.id, contact.id)).toBe(false);
      expect(await SegmentService.isMember(projectId, pro.id, contact.id)).toBe(true);
      expect(await SegmentService.isMember(projectId, free.id, contact.id)).toBe(false);
    });

    it("is false for a missing segment, another project's segment, or a filter that cannot be built", async () => {
      const contact = await factories.createContact({projectId});
      const {project: other} = await factories.createUserWithProject();
      const theirs = await prisma.segment.create({data: {projectId: other.id, name: 'Theirs', type: 'STATIC'}});
      await prisma.segmentMembership.create({data: {segmentId: theirs.id, contactId: contact.id}});
      const broken = await factories.createSegment(projectId, {
        name: 'Nested broken',
        filters: [{field: 'segment.00000000-0000-4000-8000-000000000002', operator: 'memberOfSegment'}],
      });

      expect(await SegmentService.isMember(projectId, '00000000-0000-4000-8000-000000000003', contact.id)).toBe(false);
      expect(await SegmentService.isMember(projectId, theirs.id, contact.id)).toBe(false);
      expect(await SegmentService.isMember(projectId, broken.id, contact.id)).toBe(false);
    });
  });

  describe('deleting a segment', () => {
    it('is refused while an Update contact or Condition step uses it, naming the workflows', async () => {
      const added = await staticSegment('Added', false);
      const checked = await staticSegment('Checked', false);
      const unused = await staticSegment('Unused', false);
      await workflow(
        'Onboarding',
        'test.start',
        [{key: 'add', type: WorkflowStepType.UPDATE_CONTACT, config: {segments: {add: [added.id]}}}],
        [['trigger', 'add']],
      );
      await workflow(
        'Router',
        'test.start',
        [
          {
            key: 'check',
            type: WorkflowStepType.CONDITION,
            config: {field: `segment.${checked.id}`, operator: 'exists'},
          },
        ],
        [['trigger', 'check']],
      );

      await expect(SegmentService.delete(projectId, added.id)).rejects.toMatchObject({
        code: 409,
        message: expect.stringContaining('"Onboarding"'),
      });
      await expect(SegmentService.delete(projectId, checked.id)).rejects.toMatchObject({
        code: 409,
        message: expect.stringContaining('"Router"'),
      });
      await SegmentService.delete(projectId, unused.id);
      expect(await prisma.segment.findUnique({where: {id: unused.id}})).toBeNull();
    });
  });

  describe('workflow fields', () => {
    it('lists segments after the other fields, by name, with their name as label', async () => {
      await factories.createContact({projectId, data: {plan: 'pro'}});
      const zeta = await staticSegment('Zeta', false);
      const alpha = await staticSegment('Alpha', false);

      const {typedFields} = await WorkflowService.getAvailableFields(projectId);

      const others = typedFields.filter(f => f.category !== 'Segments').map(f => f.field);
      expect(others).toEqual([...others].sort((a, b) => a.localeCompare(b)));
      expect(typedFields.slice(-2)).toEqual([
        {field: `segment.${alpha.id}`, type: 'boolean', category: 'Segments', label: 'Alpha'},
        {field: `segment.${zeta.id}`, type: 'boolean', category: 'Segments', label: 'Zeta'},
      ]);
    });
  });
});
