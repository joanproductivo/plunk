import type {Prisma} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

/**
 * Plunk Lite: the secret each webhook step signs its requests with (see webhookSignature).
 *
 * Whoever receives the webhook generates it and sets it through the API; nothing ever reads it
 * back but the step that signs with it. It lives in a table of its own rather than in the step's
 * config, which the API returns whole -- to the dashboard, to the MCP, to a duplicated workflow --
 * and which cannot change while the workflow has active runs. With no relation to the step, its
 * row goes with the step, the workflow or the project here, next to each delete.
 */

/** The step, of this workflow of this project, or a 404 */
async function findStep(projectId: string, workflowId: string, stepId: string) {
  const step = await prisma.workflowStep.findFirst({
    where: {id: stepId, workflowId, workflow: {projectId}},
    select: {type: true},
  });
  if (!step) {
    throw new HttpException(404, 'Workflow step not found');
  }
  return step;
}

export const WebhookSigningSecrets = {
  /** Set or replace a webhook step's secret. Allowed while the workflow runs: its pending runs sign with the new one */
  async set(projectId: string, workflowId: string, stepId: string, secret: string): Promise<void> {
    const step = await findStep(projectId, workflowId, stepId);
    if (step.type !== 'WEBHOOK') {
      throw new HttpException(422, 'Only a webhook step can have a signing secret');
    }
    await prisma.plunkLiteWebhookSecret.upsert({
      where: {stepId},
      create: {stepId, workflowId, projectId, secret},
      update: {secret},
    });
  },

  /** Stop signing a step's requests. Nothing to remove is not an error */
  async remove(projectId: string, workflowId: string, stepId: string): Promise<void> {
    await findStep(projectId, workflowId, stepId);
    await prisma.plunkLiteWebhookSecret.deleteMany({where: {stepId}});
  },

  /** Whether a step signs its requests -- never the secret itself */
  async status(
    projectId: string,
    workflowId: string,
    stepId: string,
  ): Promise<{active: boolean; updatedAt: string | null}> {
    await findStep(projectId, workflowId, stepId);
    const row = await prisma.plunkLiteWebhookSecret.findUnique({where: {stepId}, select: {updatedAt: true}});
    return {active: row !== null, updatedAt: row?.updatedAt.toISOString() ?? null};
  },

  /** The secret a step signs with, if it has one */
  async forStep(stepId: string): Promise<string | null> {
    const row = await prisma.plunkLiteWebhookSecret.findUnique({where: {stepId}, select: {secret: true}});
    return row?.secret ?? null;
  },

  /** With the workflows being deleted */
  forgetWorkflows(tx: Prisma.TransactionClient, projectId: string, workflowIds: string[]) {
    return tx.plunkLiteWebhookSecret.deleteMany({where: {projectId, workflowId: {in: workflowIds}}});
  },

  /** With the steps being deleted */
  forgetSteps(tx: Prisma.TransactionClient, stepIds: string[]) {
    return tx.plunkLiteWebhookSecret.deleteMany({where: {stepId: {in: stepIds}}});
  },

  /**
   * With a project's workflows -- deleting or resetting the project. Not async: it returns the
   * query itself, so that it can join a `$transaction([...])` as well as run inside one
   */
  forgetProject(client: Prisma.TransactionClient, projectId: string) {
    return client.plunkLiteWebhookSecret.deleteMany({where: {projectId}});
  },
};
