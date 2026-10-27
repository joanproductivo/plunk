/**
 * Background Job: Workflow Queue Processor
 * Processes workflow steps from the queue (for delayed steps)
 */

import type {WorkflowStepJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {FailureAlertService} from '../services/FailureAlertService.js';
import {workflowQueue} from '../services/QueueService.js';
import {WorkflowExecutionService} from '../services/WorkflowExecutionService.js';

export function createWorkflowWorker() {
  const worker = new Worker<WorkflowStepJobData>(
    workflowQueue.name,
    async (job: Job<WorkflowStepJobData>) => {
      const {executionId, stepId, type, stepExecutionId} = job.data;

      if (type === 'timeout') {
        // Handle timeout for WAIT_FOR_EVENT steps
        if (!stepExecutionId) {
          throw new Error('stepExecutionId is required for timeout jobs');
        }

        await WorkflowExecutionService.processTimeout(executionId, stepId, stepExecutionId);
      } else if (type === 'delay-end') {
        // End a DELAY: move on to the step after it, or complete the execution
        await WorkflowExecutionService.processDelayEnd(executionId, stepId);
      } else {
        // A step queued for after a delay, by jobs from before delays ended through delay-end
        await WorkflowExecutionService.processStepExecution(executionId, stepId);
      }
    },
    {
      connection: workflowQueue.opts.connection,
      concurrency: 10, // Process up to 10 workflow steps concurrently
    },
  );

  worker.on('completed', job => {
    signale.info(`[WORKFLOW-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[WORKFLOW-PROCESSOR] Job ${job?.id} failed:`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void FailureAlertService.recordWorkflowJob(job.data.executionId, err.message);
    }
  });

  worker.on('error', err => {
    signale.error('[WORKFLOW-PROCESSOR] Worker error:', err);
  });

  return worker;
}
