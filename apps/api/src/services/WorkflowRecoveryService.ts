import type {Prisma} from '@plunk/db';
import {StepExecutionStatus, WorkflowExecutionStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {FailureAlertService} from './FailureAlertService.js';
import {QueueService} from './QueueService.js';

/** How long a RUNNING run may go without a write before it counts as interrupted */
const STALE_MS = 30 * 60_000;
/** Most runs failed in one sweep; the next sweep takes the rest */
const LIMIT = 500;
/** How long after it was due a delay's end or a wait's timeout counts as lost */
const OVERDUE_MS = 30 * 60_000;
/** How long after it was due a wait that the sweep keeps re-queuing is given up on */
const STUCK_MS = 7 * 24 * 60 * 60_000;
/**
 * The sweep only fails RUNNING runs once it has run within this long before: right after the worker
 * starts, or after Redis was out (no repeatable job fires meanwhile), runs that hung on the queue
 * first get a few minutes to write again
 */
const STEADY_MS = 10 * 60_000;

/** When this process last swept */
let lastSweepAt: number | undefined;

/** What a waiting run the sweep found needs */
type WaitFix = 'delay-end' | 'timeout' | 'deleted' | 'stuck' | 'interrupted';

interface OverdueWait {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  email: string;
  currentStepId: string | null;
  stepExecutionId: string | null;
  fix: WaitFix;
}

/** A run as failRun needs it: enough to name it in the alert */
export interface RunToFail {
  id: string;
  workflowId: string;
  workflow: {name: string; projectId: string};
  contact: {email: string};
}

/**
 * Plunk Lite: runs nothing would move on any more. Runs left RUNNING by a process that stopped in the
 * middle of a step (a deploy, a restart for memory, a database cut), which also keep the contact from
 * entering the workflow again; and runs left WAITING well past the end of their wait, whose job was
 * lost (out of attempts while the database was down, or never queued before a restart).
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
   * The workflow-recovery job: waits first (it only queues), then interrupted runs, unless this
   * process has just started sweeping (see STEADY_MS)
   */
  public static async sweep(now = Date.now()): Promise<void> {
    const steady = lastSweepAt !== undefined && now - lastSweepAt < STEADY_MS;
    lastSweepAt = now;
    await this.recoverWaits();
    if (steady) {
      await this.failInterrupted();
    } else {
      signale.info('[WORKFLOW-RECOVERY] First sweep in a while: interrupted runs are checked next time');
    }
  }

  /**
   * Waiting runs whose wait should have ended over 30 minutes ago. A delay's end or a wait's timeout
   * is queued again (to run now); a run waiting on a deleted step, on a wait that never ended after
   * a week of that, or on nothing that can end it, is failed with an alert. Safe against a job that
   * is merely late: a queued job is left alone, and the jobs claim the run before moving it.
   */
  public static async recoverWaits({overdueMs = OVERDUE_MS, limit = LIMIT} = {}): Promise<number> {
    const now = Date.now();
    const overdue = new Date(now - overdueMs);
    const stuck = new Date(now - STUCK_MS);
    // resumeAt is an ISO string written by toISOString, so it compares as text
    const rows = await prisma.$queryRaw<OverdueWait[]>`
      SELECT * FROM (
        SELECT e."id", e."workflowId", w."name" AS "workflowName", w."projectId", c."email",
          e."currentStepId", e."updatedAt", se."id" AS "stepExecutionId",
          CASE
            WHEN e."currentStepId" IS NULL THEN
              CASE WHEN e."updatedAt" < ${overdue} THEN 'deleted' END
            WHEN s."type" = 'DELAY' AND se."status" = 'COMPLETED' THEN
              CASE
                WHEN COALESCE(se."output"->>'resumeAt', '') < ${stuck.toISOString()} THEN 'stuck'
                WHEN COALESCE(se."output"->>'resumeAt', '') < ${overdue.toISOString()} THEN 'delay-end'
              END
            WHEN s."type" = 'WAIT_FOR_EVENT' AND se."status" = 'WAITING' THEN
              CASE
                WHEN se."executeAfter" < ${stuck} THEN 'stuck'
                WHEN se."executeAfter" < ${overdue} THEN 'timeout'
              END
            WHEN e."updatedAt" < ${overdue} THEN 'interrupted'
          END AS "fix"
        FROM "workflow_executions" e
        JOIN "workflows" w ON w."id" = e."workflowId"
        JOIN "contacts" c ON c."id" = e."contactId"
        LEFT JOIN "workflow_steps" s ON s."id" = e."currentStepId"
        LEFT JOIN LATERAL (
          SELECT "id", "status", "output", "executeAfter" FROM "workflow_step_executions"
          WHERE "executionId" = e."id" AND "stepId" = e."currentStepId"
          ORDER BY "createdAt" DESC
          LIMIT 1
        ) se ON true
        WHERE e."status" = 'WAITING'
      ) waits
      WHERE "fix" IS NOT NULL
      ORDER BY "updatedAt" ASC
      LIMIT ${limit}
    `;

    let fixed = 0;
    for (const row of rows) {
      const run: RunToFail = {
        id: row.id,
        workflowId: row.workflowId,
        workflow: {name: row.workflowName, projectId: row.projectId},
        contact: {email: row.email},
      };
      // Only while it still waits on the same step: one that moved on meanwhile is alive
      const stillThere = {status: WorkflowExecutionStatus.WAITING, currentStepId: row.currentStepId};
      switch (row.fix) {
        case 'delay-end':
        case 'timeout':
          if (await QueueService.ensureWorkflowWaitEnd(row.fix, row.id, row.currentStepId!, row.stepExecutionId!)) {
            fixed++;
          }
          break;
        case 'deleted':
          if (
            await this.failRun(run, {
              error: 'A step was deleted while a contact was waiting on it',
              exitReason: 'Step deleted',
              where: stillThere,
            })
          ) {
            fixed++;
          }
          break;
        case 'stuck':
          if (
            await this.failRun(run, {
              error: 'A wait has not ended a week after it was due',
              exitReason: 'Stuck: its wait never ended',
              where: stillThere,
            })
          ) {
            fixed++;
          }
          break;
        case 'interrupted':
          if (
            await this.failRun(run, {
              error: 'A run was interrupted by a restart and stopped where it was',
              exitReason: 'Interrupted: the server stopped while this run was in progress',
              where: {...stillThere, updatedAt: {lt: overdue}},
            })
          ) {
            fixed++;
            await this.failOpenSteps(run.id);
          }
          break;
      }
    }

    if (fixed > 0) {
      signale.warn(`[WORKFLOW-RECOVERY] Recovered ${fixed} overdue waiting workflow run(s)`);
    }
    return fixed;
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
      await this.failOpenSteps(run.id);
    }

    if (failed > 0) {
      signale.warn(`[WORKFLOW-RECOVERY] Failed ${failed} interrupted workflow run(s)`);
    }
    return failed;
  }

  /** The steps an interrupted run left open, failed with it */
  private static async failOpenSteps(executionId: string): Promise<void> {
    await prisma.workflowStepExecution.updateMany({
      where: {
        executionId,
        status: {in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING, StepExecutionStatus.WAITING]},
      },
      data: {status: StepExecutionStatus.FAILED, completedAt: new Date(), error: 'Interrupted'},
    });
  }
}
