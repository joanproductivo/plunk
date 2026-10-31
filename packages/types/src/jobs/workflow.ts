/**
 * Workflow queue job data types
 */

/**
 * Job data for executing a workflow step
 * Used by: workflowQueue worker
 */
export interface WorkflowStepJobData {
  executionId: string;
  stepId: string;
  type?: 'process-step' | 'timeout' | 'delay-end' | 'webhook-retry' | 'resume-step'; // Job type for different handling
  stepExecutionId?: string; // For timeout and webhook-retry jobs, reference to the step execution
}
