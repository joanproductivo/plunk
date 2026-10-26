import {describe, expect, it} from 'vitest';
import {WorkflowExecutionStatus, WorkflowTriggerType} from '@plunk/db';

import {WorkflowEntryService} from '../WorkflowEntryService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * The entry decision is a check followed by a create. Two events for the same contact arriving
 * together -- SNS delivers at least once, opens come in bursts -- both passed the check before
 * either created, and the contact ran the workflow twice.
 */
describe('WorkflowEntryService', () => {
  const prisma = getPrismaClient();

  async function setup(allowReentry: boolean) {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const workflow = await factories.createWorkflow({
      projectId: project.id,
      enabled: true,
      allowReentry,
      triggerType: WorkflowTriggerType.EVENT,
      triggerConfig: {eventName: 'race.event'},
    });
    const trigger = await prisma.workflowStep.findFirstOrThrow({where: {workflowId: workflow.id, type: 'TRIGGER'}});
    return {contact, workflow, trigger};
  }

  it.each([false, true])('lets one of many concurrent entries in (allowReentry: %s)', async allowReentry => {
    const {contact, workflow, trigger} = await setup(allowReentry);

    const results = await Promise.all(
      Array.from({length: 10}, () => WorkflowEntryService.enter(workflow, contact.id, trigger.id, undefined)),
    );

    expect(results.filter(result => result.entered)).toHaveLength(1);
    expect(await prisma.workflowExecution.count({where: {workflowId: workflow.id, contactId: contact.id}})).toBe(1);
  });

  it('refuses a contact who already ran a workflow without re-entry, with the earlier status', async () => {
    const {contact, workflow, trigger} = await setup(false);
    await factories.createWorkflowExecution(workflow.id, contact.id, {status: WorkflowExecutionStatus.COMPLETED});

    const result = await WorkflowEntryService.enter(workflow, contact.id, trigger.id, undefined);

    expect(result).toEqual({
      entered: false,
      refusal: {reason: 'already-entered', status: WorkflowExecutionStatus.COMPLETED},
    });
  });

  it('lets a contact whose run is waiting enter a workflow with re-entry again', async () => {
    const {contact, workflow, trigger} = await setup(true);
    await factories.createWorkflowExecution(workflow.id, contact.id, {status: WorkflowExecutionStatus.WAITING});

    const result = await WorkflowEntryService.enter(workflow, contact.id, trigger.id, undefined);

    expect(result.entered).toBe(true);
  });
});
