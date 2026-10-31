import {Job, Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {QueueService, workflowQueue} from '../QueueService';

/**
 * Plunk Lite: the recovery sweep queues again the end of a delay (or a wait's timeout) whose job was
 * lost. BullMQ ignores an add whose ID is still taken, so a finished job has to be replaced, and a
 * job still to run must be left as it is.
 */
describe('QueueService.ensureWorkflowWaitEnd', () => {
  const jobId = 'workflow-delay-end-step-execution-1';
  const ensure = () => QueueService.ensureWorkflowWaitEnd('delay-end', 'execution-1', 'step-1', 'step-execution-1');

  beforeEach(async () => {
    await workflowQueue.obliterate({force: true});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Take the job as a worker would, and finish it with `finish` */
  async function runJob(finish: (job: Job) => Promise<unknown>) {
    const worker = new Worker(workflowQueue.name, null, {connection: workflowQueue.opts.connection, autorun: false});
    try {
      const job = await worker.getNextJob('test-token');
      await finish(job!);
    } finally {
      await worker.close();
    }
  }

  it('queues the job to run now when there is none', async () => {
    expect(await ensure()).toBe(true);

    const job = await workflowQueue.getJob(jobId);
    expect(await job!.getState()).toBe('waiting');
    expect(job!.data).toEqual({
      executionId: 'execution-1',
      stepId: 'step-1',
      stepExecutionId: 'step-execution-1',
      type: 'delay-end',
    });
  });

  it('leaves a job that is still to run as it is', async () => {
    await QueueService.queueWorkflowDelayEnd('execution-1', 'step-1', 'step-execution-1', 60_000);

    expect(await ensure()).toBe(false);

    expect(await (await workflowQueue.getJob(jobId))!.getState()).toBe('delayed');
  });

  it('replaces a job that ran out of attempts', async () => {
    await ensure();
    await runJob(async job => {
      job.discard();
      await job.moveToFailed(new Error('database down'), 'test-token', false);
    });

    expect(await ensure()).toBe(true);

    const job = await workflowQueue.getJob(jobId);
    expect(await job!.getState()).toBe('waiting');
    expect(job!.attemptsMade).toBe(0);
  });

  it('says it queued nothing when the finished job it should replace will not go', async () => {
    await ensure();
    await runJob(job => job.moveToCompleted(undefined, 'test-token', false));
    vi.spyOn(Job.prototype, 'remove').mockRejectedValueOnce(new Error('locked'));

    expect(await ensure()).toBe(false);
  });

  it('replaces a job that completed, for a run the sweep still finds waiting', async () => {
    await ensure();
    await runJob(job => job.moveToCompleted(undefined, 'test-token', false));

    expect(await ensure()).toBe(true);

    expect(await (await workflowQueue.getJob(jobId))!.getState()).toBe('waiting');
  });
});
