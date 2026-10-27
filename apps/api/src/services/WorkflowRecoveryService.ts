import type {Prisma} from '@plunk/db';
import {StepExecutionStatus, WorkflowExecutionStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {FailureAlertService} from './FailureAlertService.js';

/** How long a RUNNING run may go without a write before it counts as interrupted */
const STALE_MS = 30 * 60_000;
/** Most runs failed in one sweep; the next sweep takes the rest */
const LIMIT = 500;

/** A run as failRun needs it: enough to name it in the alert */
export interface RunToFail {
  id: string;
  workflowId: string;
  workflow: {name: string; projectId: string};
  contact: {email: string};
}

/**
 * Plunk Lite: runs left RUNNING by a process that stopped in the middle of a step (a deploy, a
 * restart for memory, a database cut). Nothing would move them on, and while RUNNING they keep the
 * contact from entering the workflow again.
 */
export class WorkflowRecoveryService {
  /**
   * Fail a run and tell the project, once: only a run still `where` says (by default one still
   * running or waiting, so a cancelled, failed or finished run keeps its status). Returns whether
   * this call failed it.
   */
  public static async failRun(
    run: RunToFail,
    {
      error,
      exitReason,
      where = {status: {in: [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING]}},
    }: {error: string; exitReason?: string; where?: Prisma.WorkflowExecutionWhereInput},
  ): Promise<boolean> {
    const {count} = await prisma.workflowExecution.updateMany({
      where: {...where, id: run.id},
      data: {status: WorkflowExecutionStatus.FAILED, completedAt: new Date(), exitReason},
    });
    if (count === 0) {
      return false;
    }
    await FailureAlertService.record(run.workflow.projectId, {
      sourceKey: `workflow:${run.workflowId}`,
      label: run.workflow.name,
      error,
      contactEmail: run.contact.email,
    });
    return true;
  }

  /**
   * Fail the runs that have been RUNNING without a write for 30 minutes, with an alert. Every step
   * writes its run (Prisma sets `updatedAt` on updateMany too), and the slowest one, a webhook, takes
   * about a minute at most, so such a run is dead. They are failed, not resumed: resuming could
   * repeat a webhook or a contact update, which are not idempotent.
   */
  public static async failInterrupted({staleMs = STALE_MS, limit = LIMIT} = {}): Promise<number> {
    const cutoff = new Date(Date.now() - staleMs);
    const stale = await prisma.workflowExecution.findMany({
      where: {status: WorkflowExecutionStatus.RUNNING, updatedAt: {lt: cutoff}},
      select: {
        id: true,
        workflowId: true,
        workflow: {select: {name: true, projectId: true}},
        contact: {select: {email: true}},
      },
      orderBy: {updatedAt: 'asc'},
      take: limit,
    });

    let failed = 0;
    for (const run of stale) {
      // Only if it is still the run that was read: one that moved on meanwhile is alive
      const interrupted = await this.failRun(run, {
        error: 'A run was interrupted by a restart and stopped where it was',
        exitReason: 'Interrupted: the server stopped while this run was in progress',
        where: {status: WorkflowExecutionStatus.RUNNING, updatedAt: {lt: cutoff}},
      });
      if (!interrupted) {
        continue;
      }
      failed++;
      await prisma.workflowStepExecution.updateMany({
        where: {
          executionId: run.id,
          status: {in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING, StepExecutionStatus.WAITING]},
        },
        data: {status: StepExecutionStatus.FAILED, completedAt: new Date(), error: 'Interrupted'},
      });
    }

    if (failed > 0) {
      signale.warn(`[WORKFLOW-RECOVERY] Failed ${failed} interrupted workflow run(s)`);
    }
    return failed;
  }
}
