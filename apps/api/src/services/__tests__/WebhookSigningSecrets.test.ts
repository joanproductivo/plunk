import {beforeEach, describe, expect, it} from 'vitest';
import {WorkflowStepType} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {WebhookSigningSecrets} from '../WebhookSigningSecrets';
import {WorkflowService} from '../WorkflowService';

const SECRET = 'a'.repeat(43);

/** Plunk Lite: the secret a webhook step signs with is set, read as a status only, and goes with its step */
describe('WebhookSigningSecrets', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let workflowId: string;
  let webhookId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    workflowId = (await factories.createWorkflow({projectId})).id;
    webhookId = (
      await factories.createWorkflowStep({
        workflowId,
        type: WorkflowStepType.WEBHOOK,
        config: {url: 'https://example.com/hook', method: 'POST'},
      })
    ).id;
  });

  it('sets, replaces and removes a secret, and only ever reports whether there is one', async () => {
    expect(await WebhookSigningSecrets.status(projectId, workflowId, webhookId)).toEqual({
      active: false,
      updatedAt: null,
    });

    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, SECRET);
    const status = await WebhookSigningSecrets.status(projectId, workflowId, webhookId);
    expect(status).toEqual({active: true, updatedAt: expect.any(String)});
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(await WebhookSigningSecrets.forStep(webhookId)).toBe(SECRET);

    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, 'b'.repeat(32));
    expect(await WebhookSigningSecrets.forStep(webhookId)).toBe('b'.repeat(32));
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(1);

    await WebhookSigningSecrets.remove(projectId, workflowId, webhookId);
    await WebhookSigningSecrets.remove(projectId, workflowId, webhookId);
    expect(await WebhookSigningSecrets.forStep(webhookId)).toBeNull();
  });

  it("answers 404 for a step of another workflow or another project's", async () => {
    const other = await factories.createUserWithProject();
    const otherWorkflow = await factories.createWorkflow({projectId: other.project.id});

    await expect(WebhookSigningSecrets.set(other.project.id, workflowId, webhookId, SECRET)).rejects.toMatchObject({
      code: 404,
    });
    await expect(WebhookSigningSecrets.status(projectId, otherWorkflow.id, webhookId)).rejects.toMatchObject({
      code: 404,
    });
    await expect(WebhookSigningSecrets.remove(projectId, workflowId, 'missing-step')).rejects.toMatchObject({
      code: 404,
    });
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it('answers 422 for a step that is not a webhook', async () => {
    const trigger = await prisma.workflowStep.findFirstOrThrow({where: {workflowId, type: WorkflowStepType.TRIGGER}});

    await expect(WebhookSigningSecrets.set(projectId, workflowId, trigger.id, SECRET)).rejects.toMatchObject({
      code: 422,
    });
  });

  it('goes with its step, deleted or spliced out', async () => {
    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, SECRET);
    await WorkflowService.deleteStep(projectId, workflowId, webhookId);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);

    const spliced = await factories.createWorkflowStep({
      workflowId,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://example.com/hook', method: 'POST'},
    });
    await WebhookSigningSecrets.set(projectId, workflowId, spliced.id, SECRET);
    await WorkflowService.spliceStep(projectId, workflowId, spliced.id);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it('goes with its workflow, deleted alone or with others', async () => {
    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, SECRET);
    await WorkflowService.delete(projectId, workflowId);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);

    const again = await factories.createWorkflow({projectId});
    const step = await factories.createWorkflowStep({
      workflowId: again.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://example.com/hook', method: 'POST'},
    });
    await WebhookSigningSecrets.set(projectId, again.id, step.id, SECRET);
    await WorkflowService.bulkUpdate(projectId, {ids: [again.id], delete: true});
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it('goes with its project, in a transaction of either form, and leaves other projects alone', async () => {
    const other = await factories.createUserWithProject();
    const otherWorkflow = await factories.createWorkflow({projectId: other.project.id});
    const otherStep = await factories.createWorkflowStep({
      workflowId: otherWorkflow.id,
      type: WorkflowStepType.WEBHOOK,
      config: {url: 'https://example.com/hook', method: 'POST'},
    });
    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, SECRET);
    await WebhookSigningSecrets.set(other.project.id, otherWorkflow.id, otherStep.id, SECRET);

    await prisma.$transaction([WebhookSigningSecrets.forgetProject(prisma, projectId)]);
    expect(await WebhookSigningSecrets.forStep(webhookId)).toBeNull();

    await prisma.$transaction(tx => WebhookSigningSecrets.forgetProject(tx, other.project.id));
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it('is not copied to a duplicated workflow, whose webhook then goes unsigned', async () => {
    await WebhookSigningSecrets.set(projectId, workflowId, webhookId, SECRET);

    const copy = await WorkflowService.duplicate(projectId, workflowId);

    const copiedWebhook = await prisma.workflowStep.findFirstOrThrow({
      where: {workflowId: copy.id, type: WorkflowStepType.WEBHOOK},
    });
    expect(await WebhookSigningSecrets.forStep(copiedWebhook.id)).toBeNull();
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(1);
  });
});
