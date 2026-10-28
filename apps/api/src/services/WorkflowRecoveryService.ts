import type {Prisma} from '@plunk/db';
import {StepExecutionStatus, WorkflowExecutionStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {utcTimestamp} from '../utils/database.js';
import {FailureAlertService} from './FailureAlertService.js';
import {QueueService} from './QueueService.js';

/**
 * How long a run may go without a write before it counts as interrupted, and how long after it was
 * due a delay's end or a wait's timeout counts as lost
 */
const STALE_MS = 30 * 60_000;
/** Most runs failed in one sweep; the next sweep takes the rest */
const LIMIT = 500;
/** How long after it was due a wait whose job is gone is given up on */
const STUCK_MS = 7 * 24 * 60 * 60_000;
/**
 * The sweep fails RUNNING runs only once it has completed sweeps without a gap for this long: after
 * the worker starts, or after Redis or the database was out (no repeatable job fires, or sweeps
 * fail, meanwhile), runs that hung on them first get time to write again. The repeatable job runs
 * every 5 minutes, and the next one right after an outage, so a single sweep proves nothing.
 * Kept per process: the worker runs as one pm2 instance.
 */
const STEADY_MS = 10 * 60_000;

/** When this process last completed a sweep, and since when without a gap */
let lastSweepAt: number | undefined;
let steadySince = 0;

/** A run a restart left where it was */
const INTERRUPTED = {
  error: 'A run was interrupted by a restart and stopped where it was',
  exitReason: 'Interrupted: the server stopped while this run was in progress',
};
/** A run whose step was deleted from under its contact, wherever it was found */
const STEP_DELETED = {error: 'A step was deleted while a contact was on its way to it', exitReason: 'Step deleted'};

/** What a waiting run the sweep found needs */
type WaitFix = 'delay-end' | 'timeout' | 'deleted' | 'stuck' | 'interrupted';

interface OverdueWait {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  email: string;
  currentStepId: string | null;
  stepType: string | null;
  stepExecutionId: string | null;
  fix: WaitFix;
}

/** A run as failRun needs it: enough to name it in the alert */
interface RunToFail {
  id: string;
  workflowId: string;
  workflow: {name: string; projectId: string};
  contact: {email: string};
}

const RUN_TO_FAIL_SELECT = {
  id: true,
  workflowId: true,
  workflow: {select: {name: true, projectId: true}},
  contact: {select: {email: true}},
} satisfies Prisma.WorkflowExecutionSelect;

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
   * Fail a run whose step was deleted under it -- or that waited on a step deleted since -- and tell
   * the project, instead of retrying the job forever or completing the run without the rest of its
   * route
   */
  public static async failDeletedStep(executionId: string): Promise<void> {
    const run = await prisma.workflowExecution.findUnique({where: {id: executionId}, select: RUN_TO_FAIL_SELECT});
    if (run) {
      await this.failRun(run, STEP_DELETED);
    }
  }

  /**
   * The workflow-recovery job: waits first (they need no grace: what it queues claims the run before
   * moving it), then interrupted runs once sweeps have run without a gap (see STEADY_MS)
   */
  public static async sweep(now = Date.now()): Promise<void> {
    await this.recoverWaits();
    if (lastSweepAt === undefined || now - lastSweepAt >= STEADY_MS) {
      steadySince = now;
    }
    lastSweepAt = now;
    if (now - steadySince >= STEADY_MS) {
      await this.failInterrupted();
    } else {
      signale.info('[WORKFLOW-RECOVERY] Sweeping again after a gap: interrupted runs are checked in a few minutes');
    }
  }

  /**
   * Waiting runs whose wait should have ended over 30 minutes ago. A delay's end or a wait's timeout
   * is queued again (to run now); a run waiting on a deleted step, on a wait that never ended after
   * a week of that, or on nothing that can end it, is failed with an alert. Safe against a job that
   * is merely late: a queued job is left alone, and the jobs claim the run before moving it.
   */
  public static async recoverWaits({overdueMs = STALE_MS, limit = LIMIT} = {}): Promise<number> {
    const now = Date.now();
    const overdue = new Date(now - overdueMs);
    const stuck = new Date(now - STUCK_MS);
    // A run is written when it starts waiting, never later until something ends the wait, so its
    // updatedAt is at most when the wait was due: `updatedAt < overdue` narrows every class below
    // without missing any. resumeAt is an ISO string written by toISOString, so it compares as text.
    const rows = await prisma.$queryRaw<OverdueWait[]>`
      SELECT waits.*, w."name" AS "workflowName", w."projectId", c."email"
      FROM (
        SELECT e."id", e."workflowId", e."contactId", e."currentStepId", e."updatedAt",
          s."type"::text AS "stepType", se."id" AS "stepExecutionId",
          CASE
            WHEN e."currentStepId" IS NULL THEN 'deleted'
            WHEN s."type" = 'DELAY' AND se."status" = 'COMPLETED' THEN
              CASE
                WHEN COALESCE(se."output"->>'resumeAt', '') < ${stuck.toISOString()} THEN 'stuck'
                WHEN COALESCE(se."output"->>'resumeAt', '') < ${overdue.toISOString()} THEN 'delay-end'
              END
            WHEN s."type" = 'WAIT_FOR_EVENT' AND se."status" = 'WAITING' THEN
              CASE
                WHEN se."executeAfter" < ${utcTimestamp(stuck)} THEN 'stuck'
                WHEN se."executeAfter" < ${utcTimestamp(overdue)} THEN 'timeout'
              END
            ELSE 'interrupted'
          END AS "fix"
        FROM "workflow_executions" e
        LEFT JOIN "workflow_steps" s ON s."id" = e."currentStepId"
        LEFT JOIN LATERAL (
          SELECT "id", "status", "output", "executeAfter" FROM "workflow_step_executions"
          WHERE "executionId" = e."id" AND "stepId" = e."currentStepId"
          ORDER BY "createdAt" DESC
          LIMIT 1
        ) se ON true
        WHERE e."status" = 'WAITING' AND e."updatedAt" < ${utcTimestamp(overdue)}
      ) waits
      JOIN "workflows" w ON w."id" = waits."workflowId"
      JOIN "contacts" c ON c."id" = waits."contactId"
      WHERE waits."fix" IS NOT NULL
      ORDER BY waits."updatedAt" ASC
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
          if (await this.failRun(run, {...STEP_DELETED, where: stillThere})) {
            fixed++;
          }
          break;
        case 'stuck':
          // A job still to run is merely late (the worker was stopped for days): it ends the wait
          if (
            await QueueService.isWorkflowWaitEndPending(
              row.stepType === 'DELAY' ? 'delay-end' : 'timeout',
              row.stepExecutionId!,
            )
          ) {
            break;
          }
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
          if (await this.failRun(run, {...INTERRUPTED, where: {...stillThere, updatedAt: {lt: overdue}}})) {
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
      select: RUN_TO_FAIL_SELECT,
      orderBy: {updatedAt: 'asc'},
      take: limit,
    });

    let failed = 0;
    for (const run of stale) {
      // Only if it is still the run that was read: one that moved on meanwhile is alive
      const interrupted = await this.failRun(run, {
        ...INTERRUPTED,
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
