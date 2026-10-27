import type {Prisma} from '@plunk/db';

/**
 * Plunk Lite: a workflow's emails outlive the workflow and its steps.
 *
 * An email points to the execution and the step execution that sent it, and both relations
 * cascade: deleting a workflow deletes its executions, and deleting a step its step executions,
 * and with them every email they sent. A bounce or complaint SES reports afterwards then finds no
 * email, and the reputation rates lose a send AWS still counts. So before each delete, in the same
 * transaction, its emails let go of what is about to be deleted. They stay workflow emails
 * (`sourceType`), only without the execution, so the activity shows them with no link to it.
 */

/** Unlinking every email of a big workflow can outlast Prisma's 5 s default */
export const WORKFLOW_DELETE_TRANSACTION = {timeout: 60_000, maxWait: 10_000};

export const WorkflowEmailLinks = {
  /** Before deleting workflows: their emails keep neither execution nor step execution */
  detachWorkflows(tx: Prisma.TransactionClient, projectId: string, workflowIds: string[]) {
    return tx.email.updateMany({
      where: {projectId, workflowExecution: {workflowId: {in: workflowIds}}},
      data: {workflowExecutionId: null, workflowStepExecutionId: null},
    });
  },

  /**
   * Before deleting steps: their emails lose the step execution, and keep the execution, which
   * stays -- so they still count for the workflow's own brake
   */
  detachSteps(tx: Prisma.TransactionClient, stepIds: string[]) {
    return tx.email.updateMany({
      where: {workflowStepExecution: {stepId: {in: stepIds}}},
      data: {workflowStepExecutionId: null},
    });
  },
};
