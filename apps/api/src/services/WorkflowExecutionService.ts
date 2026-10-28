import type {
  Contact,
  Email,
  Prisma,
  Template,
  Workflow,
  WorkflowExecution,
  WorkflowStep,
  WorkflowStepExecution,
} from '@plunk/db';
import {StepExecutionStatus, WorkflowExecutionStatus} from '@plunk/db';
import type {SegmentChangesResult, UpdateContactSegmentChanges} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import {canScopeWaitToExecution, renderTemplate, WorkflowStepConfigSchemas} from '@plunk/shared';
import dns from 'node:dns/promises';
import net from 'node:net';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {DASHBOARD_URI} from '../app/constants.js';
import {POOL_WAIT_TRANSACTION} from '../utils/database.js';
import {readCapped} from '../utils/readCapped.js';

import {RECIPIENT_OVERRIDE_HEADER} from './EmailHeaderService.js';
import {EmailService} from './EmailService.js';
import {NtfyService} from './NtfyService.js';
import {QueueService} from './QueueService.js';
import {SuppressionService} from './SuppressionService.js';
import {WorkflowRecoveryService} from './WorkflowRecoveryService.js';

// A step's error is rethrown through the catch of every step before it in the same run, which
// had completed; the step it came from has handled it, so those pass it up untouched.
const handledFailures = new WeakSet<object>();

/** Plunk Lite: rolls back the claim of a wait whose run no longer waits */
class WaitNotClaimed extends Error {}

/** Plunk Lite: most of a webhook step's response that is read and stored */
const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

// Plunk Lite: runs that never move again -- cancelled (by hand or by a workflow's brake), or failed
// (by a step, or by the recovery sweep after a restart). An EXITED run is not one of them: Plunk
// still completes it when its EXIT step has nothing after it.
const STOPPED_STATUSES: WorkflowExecutionStatus[] = [WorkflowExecutionStatus.CANCELLED, WorkflowExecutionStatus.FAILED];

// Plunk Lite: what moving a run on never touches -- a stopped run, or one that waits, which only
// what ends its wait may move (claiming it first)
const UNMOVABLE_STATUSES: WorkflowExecutionStatus[] = [...STOPPED_STATUSES, WorkflowExecutionStatus.WAITING];

type StepConfig = Prisma.JsonValue;
type StepResult = Record<string, unknown>;
type WorkflowExecutionWithRelations = WorkflowExecution & {contact: Contact; workflow: Workflow};
type WorkflowStepWithTemplate = WorkflowStep & {template?: Template | null};
type WorkflowStepWithTransitions = WorkflowStep & {
  outgoingTransitions?: Array<{
    id: string;
    condition: Prisma.JsonValue;
    priority: number;
    toStep: WorkflowStep;
  }>;
};

/**
 * Core Workflow Execution Engine
 * Handles the execution of workflows step by step
 */
export class WorkflowExecutionService {
  /**
   * Process a single step execution
   * This is the main entry point for executing workflow steps
   */
  public static async processStepExecution(executionId: string, stepId: string): Promise<void> {
    signale.info(`[WORKFLOW] Processing step execution: ${executionId} -> ${stepId}`);

    const execution = await prisma.workflowExecution.findUnique({
      where: {id: executionId},
      include: {
        workflow: {
          include: {
            steps: {
              include: {
                template: true,
                outgoingTransitions: {
                  orderBy: {priority: 'asc'},
                  include: {toStep: true},
                },
              },
            },
            project: {
              select: {disabled: true, id: true, name: true},
            },
          },
        },
        contact: true,
      },
    });

    if (!execution) {
      // Plunk Lite: its contact or workflow was deleted; retrying the job would not bring it back
      signale.warn(`[WORKFLOW] Execution ${executionId} not found, skipping`);
      return;
    }

    signale.info(`[WORKFLOW] Execution ${executionId} status: ${execution.status}`);

    // Plunk Lite: steps run only in a running run. Whatever resumes a waiting one (its delay's end,
    // its event or timeout) claims it as RUNNING first, so a job that finds it in any other status
    // is a late copy: the run waits, or has finished, been cancelled or failed
    if (execution.status !== WorkflowExecutionStatus.RUNNING) {
      signale.info(`[WORKFLOW] Execution ${executionId} is ${execution.status}, not running: skipping step ${stepId}`);
      return;
    }

    // Check if project is disabled
    if (execution.workflow.project.disabled) {
      signale.warn(
        `[WORKFLOW] Project ${execution.workflow.projectId} (${execution.workflow.project.name}) is disabled, cancelling workflow execution ${executionId}`,
      );
      await prisma.workflowExecution.update({
        where: {id: executionId},
        data: {
          status: WorkflowExecutionStatus.CANCELLED,
          completedAt: new Date(),
          exitReason: 'Project disabled',
        },
      });
      return;
    }

    // Check if workflow is disabled
    // Note: We allow running executions to complete even if workflow is disabled
    // This prevents disruption to contacts who are already in the workflow
    // Only NEW executions are prevented when workflow is disabled (see startExecution in WorkflowService)
    if (!execution.workflow.enabled) {
      signale.info(
        `[WORKFLOW] Workflow ${execution.workflow.id} (${execution.workflow.name}) is disabled, but allowing execution ${executionId} to continue`,
      );
      // Allow execution to continue - no action needed
    }

    const step = execution.workflow.steps.find(s => s.id === stepId);
    if (!step) {
      signale.error(`[WORKFLOW] Step ${stepId} not found in workflow ${execution.workflow.id}`);
      await WorkflowRecoveryService.failDeletedStep(executionId);
      return;
    }

    signale.info(`[WORKFLOW] Found step: ${step.name} (${step.type})`);

    // Plunk Lite: each step runs once per run (the graph has no cycles). A repeated job -- a retry
    // after a restart in the middle of a chain -- finds what this run already did here and carries
    // on from it, without doing it again: a condition keeps its branch, an email is not resent.
    const previous = await prisma.workflowStepExecution.findFirst({
      where: {executionId, stepId, status: {in: [StepExecutionStatus.COMPLETED, StepExecutionStatus.WAITING]}},
      orderBy: {createdAt: 'desc'},
      select: {status: true, output: true},
    });
    if (previous) {
      // A delay or wait already set up or done: the run either waits there (marked with the step,
      // in one transaction) or was moved on by whoever ended it -- a copy of a job must not pull it
      // back, nor set the wait up twice
      if (step.type === 'DELAY' || step.type === 'WAIT_FOR_EVENT') {
        return;
      }
      await this.processNextSteps(execution, step, this.storedResult(previous.output));
      return;
    }

    // Create or get step execution record
    let stepExecution = await prisma.workflowStepExecution.findFirst({
      where: {
        executionId,
        stepId,
        status: {in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING]},
      },
    });

    if (!stepExecution) {
      signale.info(`[WORKFLOW] Creating new step execution for ${executionId} -> ${stepId}`);
      try {
        stepExecution = await prisma.workflowStepExecution.create({
          data: {
            executionId,
            stepId,
            status: StepExecutionStatus.RUNNING,
            startedAt: new Date(),
          },
        });
        signale.info(`[WORKFLOW] Created step execution ${stepExecution.id}`);
      } catch (error) {
        signale.error(`[WORKFLOW] Failed to create step execution for ${executionId} -> ${stepId}:`, error);
        throw error;
      }
    } else {
      stepExecution = await prisma.workflowStepExecution.update({
        where: {id: stepExecution.id},
        data: {
          status: StepExecutionStatus.RUNNING,
          startedAt: stepExecution.startedAt || new Date(),
        },
      });
      signale.info(`[WORKFLOW] Updated existing step execution ${stepExecution.id} to RUNNING`);
    }

    // True once the step itself has completed: an error after that comes from moving on from it
    let stepCompleted = false;

    try {
      // Execute the step based on its type
      signale.info(`[WORKFLOW] Executing step ${stepId} of type ${step.type}`);
      const result = await this.executeStep(step, execution, stepExecution);
      signale.info(`[WORKFLOW] Step ${stepId} executed successfully`);

      // Plunk Lite: a wait or a delay never moves on from here -- the event, its timeout or the
      // delay's job does. Reading the state back raced with an event that claimed the wait in
      // between, and the run moved on twice.
      if (step.type === 'WAIT_FOR_EVENT' || step.type === 'DELAY') {
        return;
      }

      // Mark step as completed (for normal steps that complete immediately). Plunk Lite: only once --
      // another copy of this job that completed it first moves the run on, not this one
      const {count: completed} = await prisma.workflowStepExecution.updateMany({
        where: {id: stepExecution.id, status: StepExecutionStatus.RUNNING},
        data: {
          status: StepExecutionStatus.COMPLETED,
          completedAt: new Date(),
          output: result ? toPrismaJson(result) : undefined,
        },
      });
      if (completed === 0) {
        return;
      }
      stepCompleted = true;

      // Determine next step(s) based on transitions and conditions
      await this.processNextSteps(execution, step, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Pass up untouched an error a later step of this run already handled. An error of this step
      // itself is always handled (Plunk Lite: another run it resumes through an event keeps its own
      // failure, see handleEvent).
      const isObject = typeof error === 'object' && error !== null;
      if (stepCompleted && isObject && handledFailures.has(error)) {
        throw error;
      }
      if (isObject) {
        handledFailures.add(error);
      }

      signale.error(`[WORKFLOW] Error executing step ${step.id}:`, error);
      // Mark step as failed, unless it completed: then moving on from it is what failed, and the
      // step keeps its result with the error
      if (stepCompleted) {
        await prisma.workflowStepExecution.update({where: {id: stepExecution.id}, data: {error: message}});
      } else {
        // Plunk Lite: only a step still in progress. One that reached its wait, or that an event or
        // a timeout completed meanwhile, is left as it is with its run: what failed after it was set
        // up (queueing its timer) the recovery sweep makes up for, and the run may be moving on
        const {count} = await prisma.workflowStepExecution.updateMany({
          where: {
            id: stepExecution.id,
            status: {in: [StepExecutionStatus.PENDING, StepExecutionStatus.RUNNING]},
          },
          data: {status: StepExecutionStatus.FAILED, completedAt: new Date(), error: message},
        });
        if (count === 0) {
          signale.warn(
            `[WORKFLOW] Step ${step.id} of execution ${executionId} already waits or ended; leaving its run as it is`,
          );
          throw error;
        }
      }

      // Mark workflow execution as failed (Plunk Lite: unless it was stopped meanwhile -- a run the
      // brake cancelled stays cancelled, one the sweep failed is not alerted twice)
      const failed = await WorkflowRecoveryService.failRun(execution, {error: message});

      // Send notification about workflow execution failure
      if (failed) {
        await NtfyService.notifyWorkflowExecutionFailed(
          execution.workflow.name,
          execution.workflow.project.name,
          execution.workflow.project.id,
          execution.contact.email,
          message,
        );
      }

      throw error;
    }
  }

  /**
   * Process timeout for a WAIT_FOR_EVENT step
   * Called by BullMQ worker when timeout job executes
   */
  public static async processTimeout(executionId: string, stepId: string, stepExecutionId: string): Promise<void> {
    // Fetch the step execution
    const stepExecution = await prisma.workflowStepExecution.findUnique({
      where: {id: stepExecutionId},
      include: {
        execution: true,
        step: {
          include: {
            outgoingTransitions: {
              include: {toStep: true},
              orderBy: {priority: 'asc'},
            },
          },
        },
      },
    });

    if (!stepExecution) {
      return;
    }

    // Only process if step is still waiting (event might have arrived before timeout)
    // and the execution still waits on it (Plunk Lite: not stopped, nor finished)
    if (
      stepExecution.status !== StepExecutionStatus.WAITING ||
      stepExecution.execution.status !== WorkflowExecutionStatus.WAITING
    ) {
      return;
    }

    // Mark step as completed with timeout, unless the event claimed the wait since it was read.
    // Plunk Lite: the execution is claimed with it, as RUNNING, so a failure or a restart from here
    // on leaves a running run the recovery sweep sees, not a waiting one with its wait used up
    const claimed = await this.claimWait(stepExecution.id, stepExecution.executionId, stepExecution.stepId, {
      timedOut: true,
      eventName:
        stepExecution.step.config &&
        typeof stepExecution.step.config === 'object' &&
        'eventName' in stepExecution.step.config
          ? stepExecution.step.config.eventName
          : undefined,
    });

    if (!claimed) {
      return;
    }

    // Continue workflow - find transitions with timeout/fallback logic
    const transitions = stepExecution.step.outgoingTransitions || [];
    const fallbackTransition = transitions.find(
      t =>
        (t.condition &&
          typeof t.condition === 'object' &&
          'branch' in t.condition &&
          t.condition.branch === 'timeout') ||
        (t.condition && typeof t.condition === 'object' && 'fallback' in t.condition && t.condition.fallback === true),
    );

    if (fallbackTransition) {
      // Follow timeout branch
      if (await this.moveRun(stepExecution.executionId, fallbackTransition.toStep.id)) {
        await this.processStepExecution(stepExecution.executionId, fallbackTransition.toStep.id);
      }
    } else if (transitions.length > 0) {
      // No timeout branch, follow first transition
      const firstTransition = transitions[0];
      if (firstTransition?.toStep) {
        const nextStep = firstTransition.toStep;
        if (await this.moveRun(stepExecution.executionId, nextStep.id)) {
          await this.processStepExecution(stepExecution.executionId, nextStep.id);
        }
      }
    } else {
      // No transitions, complete workflow (Plunk Lite: a cancelled or failed run keeps its status,
      // and a waiting one is left to what ends its wait)
      await prisma.workflowExecution.updateMany({
        where: {id: stepExecution.executionId, status: {notIn: UNMOVABLE_STATUSES}},
        data: {
          status: WorkflowExecutionStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * End a DELAY step: move on to the step connected after it now -- one connected, removed or
   * replaced while the contact waited included -- or complete the run if there is none
   * Called by BullMQ worker when the delay-end job executes
   */
  public static async processDelayEnd(executionId: string, stepId: string): Promise<void> {
    const execution = await prisma.workflowExecution.findUnique({where: {id: executionId}});

    // Cancelled, deleted, or already moved on: nothing left to end
    if (execution?.status !== WorkflowExecutionStatus.WAITING) {
      return;
    }

    // Plunk Lite: the delay itself was deleted while the run waited on it (its current step became
    // null): the rest of the route went with it, so the run fails rather than completing quietly
    if (execution.currentStepId === null) {
      await WorkflowRecoveryService.failDeletedStep(executionId);
      return;
    }

    // A step may have been connected after the delay while the contact was waiting
    const firstTransition = await prisma.workflowTransition.findFirst({
      where: {fromStepId: stepId},
      orderBy: {priority: 'asc'},
    });

    // Plunk Lite: the run is claimed only while it still waits on this very delay, so a repeated
    // copy of this job, or one for a delay the run has since left, does nothing
    const waitingHere = {id: executionId, status: WorkflowExecutionStatus.WAITING, currentStepId: stepId};

    if (firstTransition) {
      const {count} = await prisma.workflowExecution.updateMany({
        where: waitingHere,
        data: {status: WorkflowExecutionStatus.RUNNING, currentStepId: firstTransition.toStepId},
      });
      if (count > 0) {
        await this.processStepExecution(executionId, firstTransition.toStepId);
      }
      return;
    }

    // Nothing is connected after the delay now, so the workflow is done (claimed like the move above)
    await prisma.workflowExecution.updateMany({
      where: waitingHere,
      data: {
        status: WorkflowExecutionStatus.COMPLETED,
        completedAt: new Date(),
        currentStepId: null,
      },
    });
  }

  /**
   * Plunk Lite: a process-step job queued before delays ended through their own job, for the step
   * after a DELAY. Only a run still waiting on a delay is moved, and through that delay's end, so it
   * follows the steps connected after the delay now (one inserted or deleted while it waited
   * included). A delay that has not run out yet gets its end queued for when it does. Anything else
   * -- a run already moved on, a wait for an event, a copy of the job -- is left alone.
   */
  public static async resumeLegacyStep(executionId: string): Promise<void> {
    const execution = await prisma.workflowExecution.findUnique({
      where: {id: executionId},
      select: {status: true, currentStepId: true, currentStep: {select: {type: true}}},
    });
    if (execution?.status !== WorkflowExecutionStatus.WAITING) {
      return;
    }
    if (execution.currentStepId === null) {
      // The delay was deleted while the run waited on it
      await WorkflowRecoveryService.failDeletedStep(executionId);
      return;
    }
    if (execution.currentStep?.type !== 'DELAY') {
      return;
    }

    const delay = await prisma.workflowStepExecution.findFirst({
      where: {executionId, stepId: execution.currentStepId, status: StepExecutionStatus.COMPLETED},
      orderBy: {createdAt: 'desc'},
      select: {id: true, output: true},
    });
    const resumeAt = delay ? this.storedResult(delay.output).resumeAt : undefined;
    const left = typeof resumeAt === 'string' ? Date.parse(resumeAt) - Date.now() : Number.NaN;
    if (delay && left > 0) {
      await QueueService.queueWorkflowDelayEnd(executionId, execution.currentStepId, delay.id, left);
      return;
    }
    await this.processDelayEnd(executionId, execution.currentStepId);
  }

  /**
   * Handle event occurrence and resume waiting workflows
   */
  public static async handleEvent(
    projectId: string,
    eventName: string,
    contactId?: string,
    data?: Record<string, unknown>,
    emailId?: string,
  ): Promise<void> {
    // Plunk Lite: a wait belongs to one contact, so an event without one resumes none (it used to
    // resume every contact waiting for that name)
    if (!contactId) {
      return;
    }

    // Find workflows waiting for this event (a cancelled execution keeps its wait step WAITING)
    const waitingExecutions = await prisma.workflowStepExecution.findMany({
      where: {
        status: StepExecutionStatus.WAITING,
        execution: {
          workflow: {projectId},
          // Plunk Lite: only a run that still waits resumes -- a cancelled or failed one keeps its
          // wait step WAITING, and a finished one may carry an old one
          status: WorkflowExecutionStatus.WAITING,
          contactId,
        },
        step: {
          type: 'WAIT_FOR_EVENT',
        },
      },
      include: {
        execution: {
          include: {
            contact: true,
            workflow: true,
          },
        },
        step: {
          include: {
            outgoingTransitions: {
              orderBy: {priority: 'asc'},
              include: {toStep: true},
            },
          },
        },
      },
    });

    // The email behind the event, loaded at most once and only for a wait scoped to its execution
    let sourceEmail: Pick<Email, 'workflowExecutionId' | 'headers'> | null | undefined;

    for (const stepExecution of waitingExecutions) {
      const config = stepExecution.step.config;

      if (config && typeof config === 'object' && 'eventName' in config && config.eventName === eventName) {
        // A wait scoped to its execution counts only the emails that execution sent to the contact
        if ('scope' in config && config.scope === 'execution' && canScopeWaitToExecution(eventName)) {
          if (sourceEmail === undefined) {
            sourceEmail = emailId
              ? await prisma.email.findUnique({
                  where: {id: emailId},
                  select: {workflowExecutionId: true, headers: true},
                })
              : null;
          }

          if (!this.sentByExecution(sourceEmail, stepExecution.executionId)) {
            continue;
          }
        }

        // Event matches. Claim the wait before resuming it: the list above can be stale by now,
        // as the same event may be delivered twice at once (SES notifications, repeated clicks)
        // or tracked again while an earlier wait of this loop was resumed. Whoever moves the
        // step out of WAITING resumes it; everyone else leaves it alone.
        // Plunk Lite: the execution is claimed with it, as RUNNING, so a failure or a restart from
        // here on leaves a running run the recovery sweep sees, not a waiting one with its wait used up
        const claimed = await this.claimWait(stepExecution.id, stepExecution.executionId, stepExecution.stepId, {
          eventName,
          eventData: data ? toPrismaJson(data) : undefined,
          receivedAt: new Date().toISOString(),
        });

        if (!claimed) {
          continue;
        }

        // Cancel any pending timeout job. Best effort, without waiting on a Redis that does not
        // answer: a timeout job left behind finds the wait claimed and stops.
        await QueueService.queueWithoutWaiting(
          QueueService.cancelWorkflowTimeout(stepExecution.id),
          `the removal of the timeout of step execution ${stepExecution.id}`,
        );

        // Continue workflow. Plunk Lite: one resumed run's failure stays in that run -- it must not
        // stop the others waiting for this event, nor fail whatever tracked it (a /v1/track call,
        // another workflow's step)
        try {
          await this.processNextSteps(stepExecution.execution, stepExecution.step, {eventReceived: true});
        } catch (error) {
          await this.failResumedRun(stepExecution.execution, error);
        }
      }
    }
  }

  /**
   * Whether an email was sent to the contact by the given execution. An email a step sent to a
   * custom recipient is recorded under the contact too, but it is not the contact's engagement.
   */
  private static sentByExecution(
    email: Pick<Email, 'workflowExecutionId' | 'headers'> | null,
    executionId: string,
  ): boolean {
    if (email?.workflowExecutionId !== executionId) {
      return false;
    }

    const headers =
      email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers) ? email.headers : {};

    return !(RECIPIENT_OVERRIDE_HEADER in headers);
  }

  /**
   * Execute a specific step based on its type
   */
  private static async executeStep(
    step: WorkflowStepWithTemplate,
    execution: WorkflowExecutionWithRelations,
    stepExecution: WorkflowStepExecution,
  ): Promise<StepResult> {
    const config = step.config;

    switch (step.type) {
      case 'TRIGGER':
        return await this.executeTrigger(step, execution, stepExecution, config);

      case 'SEND_EMAIL':
        return await this.executeSendEmail(step, execution, stepExecution, config);

      case 'DELAY':
        return await this.executeDelay(step, execution, stepExecution, config);

      case 'WAIT_FOR_EVENT':
        return await this.executeWaitForEvent(step, execution, stepExecution, config);

      case 'CONDITION':
        return await this.executeCondition(step, execution, stepExecution, config);

      case 'EXIT':
        return await this.executeExit(step, execution, stepExecution, config);

      case 'WEBHOOK':
        return await this.executeWebhook(step, execution, stepExecution, config);

      case 'UPDATE_CONTACT':
        return await this.executeUpdateContact(step, execution, stepExecution, config);

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * TRIGGER step - Entry point of workflow
   */
  private static async executeTrigger(
    _step: WorkflowStep,
    _execution: WorkflowExecutionWithRelations,
    _stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    // Trigger step is just the entry point, it doesn't do anything
    // But we can log or track that the workflow started
    const eventName = config && typeof config === 'object' && 'eventName' in config ? config.eventName : 'manual';
    return {
      triggered: true,
      eventName,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * SEND_EMAIL step - Send an email to the contact or a custom recipient
   */
  private static async executeSendEmail(
    step: WorkflowStepWithTemplate,
    execution: WorkflowExecutionWithRelations,
    stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    if (!step.template) {
      throw new Error('No template configured for SEND_EMAIL step');
    }

    // Parse and validate step config using schema
    const stepConfig = WorkflowStepConfigSchemas.sendEmail.parse(config);
    const recipientConfig = stepConfig.recipient || {type: 'CONTACT' as const};

    // Get contact data for variable substitution
    const contact = execution.contact;

    // Determine recipient email
    // Schema validation ensures customEmail exists when type is CUSTOM
    const recipientEmail = recipientConfig.type === 'CUSTOM' ? recipientConfig.customEmail! : contact.email;

    // Plunk Lite: a repeated run of this step (a job retried after the send) finds the email it
    // already queued -- or the failed one of an unsubscribed contact -- and does not send another
    const sent = await prisma.email.findFirst({
      where: {workflowStepExecutionId: stepExecution.id},
      select: {id: true, createdAt: true},
    });
    if (sent) {
      return {
        emailId: sent.id,
        sentAt: sent.createdAt,
        recipientType: recipientConfig.type,
        recipientEmail,
        repeated: true,
      };
    }

    const contactData =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};

    // Render template with contact data
    const executionContext =
      execution.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
        ? (execution.context as Record<string, unknown>)
        : {};

    const variables = {
      id: contact.id,
      email: contact.email,
      ...contactData,
      ...executionContext,
      data: contactData,
      event: executionContext,
      unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/${contact.id}`,
      subscribeUrl: `${DASHBOARD_URI}/subscribe/${contact.id}`,
      manageUrl: `${DASHBOARD_URI}/manage/${contact.id}`,
    };

    const renderedSubject = this.renderTemplate(step.template.subject, variables);
    const renderedBody = this.renderTemplate(step.template.body, variables);

    // Send email via EmailService
    const email = await EmailService.sendWorkflowEmail({
      projectId: execution.workflow.projectId,
      contactId: contact.id, // Keep original contact for tracking
      workflowExecutionId: execution.id,
      workflowStepExecutionId: stepExecution.id, // Use stepExecution.id, not step.id
      templateId: step.template.id,
      subject: renderedSubject,
      body: renderedBody,
      from: step.template.from,
      fromName: step.template.fromName || undefined,
      replyTo: step.template.replyTo || undefined,
      // Pass custom recipient email if specified
      recipientEmail: recipientConfig.type === 'CUSTOM' ? recipientConfig.customEmail : undefined,
    });

    return {
      emailId: email.id,
      sentAt: email.createdAt,
      recipientType: recipientConfig.type,
      recipientEmail,
    };
  }

  /**
   * DELAY step - Wait for a specified duration
   */
  private static async executeDelay(
    _step: WorkflowStep,
    _execution: WorkflowExecutionWithRelations,
    stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const {amount, unit} = WorkflowStepConfigSchemas.delay.parse(config);

    // Calculate delay in milliseconds
    let delayMs = 0;

    switch (unit) {
      case 'minutes':
        delayMs = amount * 60 * 1000;
        break;
      case 'hours':
        delayMs = amount * 60 * 60 * 1000;
        break;
      case 'days':
        delayMs = amount * 24 * 60 * 60 * 1000;
        break;
      default:
        throw new Error(`Unknown delay unit: ${unit}`);
    }

    const resumeAt = new Date(Date.now() + delayMs);

    // Mark step as completed immediately (BullMQ handles the delay), and the execution as waiting
    // (a cancelled one stays cancelled; what is queued below then does nothing). Plunk Lite: in one
    // transaction, so a restart never leaves one without the other
    await prisma.$transaction([
      prisma.workflowStepExecution.update({
        where: {id: stepExecution.id},
        data: {
          status: StepExecutionStatus.COMPLETED,
          completedAt: new Date(),
          output: {
            delayAmount: amount,
            delayUnit: unit,
            resumeAt: resumeAt.toISOString(),
          },
        },
      }),
      prisma.workflowExecution.updateMany({
        where: {id: _execution.id, status: {notIn: STOPPED_STATUSES}},
        data: {status: WorkflowExecutionStatus.WAITING},
      }),
    ]);

    // Plunk Lite: the delay always ends through its own job, which follows the step connected after
    // it when it runs out. Queuing the step connected now failed the run if that step was deleted
    // meanwhile, and skipped one inserted after the delay. If the server stops before it is queued,
    // the recovery sweep queues it.
    await QueueService.queueWorkflowDelayEnd(_execution.id, _step.id, stepExecution.id, Math.max(0, delayMs));

    return {
      delayAmount: amount,
      delayUnit: unit,
      resumeAt: resumeAt.toISOString(),
      queued: true,
    };
  }

  /**
   * WAIT_FOR_EVENT step - Wait for a specific event to occur
   */
  private static async executeWaitForEvent(
    _step: WorkflowStep,
    _execution: WorkflowExecutionWithRelations,
    stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const {eventName, timeout} = WorkflowStepConfigSchemas.waitForEvent.parse(config);

    // Calculate timeout
    const timeoutDate = timeout ? new Date(Date.now() + timeout * 1000) : null;

    // Plunk Lite: the run and its step wait together, in one transaction. Step first, an event
    // could claim it and move the run on before the run was marked WAITING, leaving it WAITING for
    // good; run first, a restart in between left it waiting on a step nothing would claim. A run
    // that is no longer running (cancelled meanwhile) sets up no wait.
    const waiting = await prisma.$transaction(async tx => {
      const {count} = await tx.workflowExecution.updateMany({
        where: {id: _execution.id, status: WorkflowExecutionStatus.RUNNING},
        data: {status: WorkflowExecutionStatus.WAITING},
      });
      if (count === 0) {
        return false;
      }
      await tx.workflowStepExecution.update({
        where: {id: stepExecution.id},
        data: {
          status: StepExecutionStatus.WAITING,
          executeAfter: timeoutDate,
        },
      });
      return true;
    }, POOL_WAIT_TRANSACTION);
    if (!waiting) {
      return {eventName, timeout: timeout || null, waitingUntil: null};
    }

    // Queue timeout handler if timeout is specified (if the server stops first, the recovery sweep
    // queues it)
    if (timeout && timeout > 0) {
      const timeoutMs = timeout * 1000;
      await QueueService.queueWorkflowTimeout(_execution.id, _step.id, stepExecution.id, timeoutMs);
    }

    return {
      eventName,
      timeout: timeout || null,
      waitingUntil: timeoutDate?.toISOString() || 'indefinite',
    };
  }

  /**
   * CONDITION step - Evaluate a condition and determine branching
   */
  private static async executeCondition(
    _step: WorkflowStep,
    execution: WorkflowExecutionWithRelations,
    _stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const parsed = WorkflowStepConfigSchemas.condition.parse(config);

    // Get the value to evaluate
    const contact = execution.contact;
    const contactData =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};
    const context = execution.context || {};

    // Resolve the field value (support dot notation)
    // Structure allows access to:
    // - contact.email, contact.subscribed
    // - data.firstName, data.lastName, etc.
    // - workflow.* (execution context - alias for event data)
    // - event.* (event data that triggered the workflow)
    // - segment.<id> (whether the contact is in that segment now; see conditionValue)
    const fieldData = {
      contact: {
        email: contact.email,
        subscribed: contact.subscribed,
      },
      data: contactData,
      workflow: context,
      event: context, // Alias for easier access to event data
    };

    // Multi-branch mode (switch/case)
    if ('mode' in parsed && parsed.mode === 'multi') {
      const actualValue = await this.conditionValue(parsed.field, fieldData, execution);

      for (const branch of parsed.branches) {
        if (this.evaluateCondition(actualValue, branch.operator, branch.value)) {
          return {
            field: parsed.field,
            mode: 'multi',
            matchedBranch: branch.name,
            actualValue,
            branch: branch.id,
          };
        }
      }

      // No branch matched — use default
      return {
        field: parsed.field,
        mode: 'multi',
        matchedBranch: 'default',
        actualValue,
        branch: 'default',
      };
    }

    // Legacy binary mode (if/else)
    const field = parsed.field;
    const operator = 'operator' in parsed ? parsed.operator : 'equals';
    const value = 'value' in parsed ? parsed.value : undefined;
    const actualValue = await this.conditionValue(field, fieldData, execution);
    const result = this.evaluateCondition(actualValue, operator, value);

    return {
      field,
      operator,
      expectedValue: value,
      // Convert undefined to null so it's preserved in JSON (JSON.stringify removes undefined)
      actualValue: actualValue === undefined ? null : actualValue,
      result,
      branch: result ? 'yes' : 'no',
    };
  }

  /**
   * EXIT step - Terminate the workflow
   */
  private static async executeExit(
    _step: WorkflowStep,
    execution: WorkflowExecutionWithRelations,
    _stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const reason =
      config &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      'reason' in config &&
      typeof config.reason === 'string'
        ? config.reason
        : 'exit_step';

    // Mark workflow as exited (a cancelled one stays cancelled, so nothing after this step runs)
    await this.updateUnlessStopped(execution.id, {
      status: WorkflowExecutionStatus.EXITED,
      exitReason: reason || undefined,
      completedAt: new Date(),
    });

    return {
      exited: true,
      reason,
    };
  }

  /**
   * True if a dotted-quad IPv4 address is in a private/reserved range.
   */
  private static isPrivateIpv4(addr: string): boolean {
    const parts = addr.split('.').map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;

    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 shared address space
      a === 0 || // 0.0.0.0/8
      a >= 224 // 224.0.0.0+ multicast and reserved
    );
  }

  /**
   * Expands an IPv6 address into its 8 hextets (16-bit numbers).
   *
   * Handles `::` compression, an optional zone id, and a trailing dotted-quad
   * (e.g. `::ffff:169.254.169.254`). Returns null if the address is malformed —
   * callers must treat that as untrusted.
   */
  private static expandIpv6(addr: string): number[] | null {
    // Drop the zone id (fe80::1%eth0) — it is not part of the address
    const bare = addr.split('%')[0]?.toLowerCase() ?? '';

    // A trailing dotted-quad occupies the final two hextets
    let head = bare;
    const dotted = bare.lastIndexOf(':');
    const tail = bare.slice(dotted + 1);
    let embedded: number[] = [];
    if (tail.includes('.')) {
      if (!net.isIPv4(tail)) {
        return null;
      }
      const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
      embedded = [(a << 8) | b, (c << 8) | d];
      head = bare.slice(0, dotted + 1);
      // `::1.2.3.4` leaves a trailing `::`, `1::1.2.3.4` a trailing `:`
      head = head.endsWith('::') ? head : head.slice(0, -1);
    }

    const halves = head.split('::');
    if (halves.length > 2) {
      return null;
    }

    const toHextets = (part: string) =>
      part === '' ? [] : part.split(':').map(h => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN));

    const left = toHextets(halves[0] ?? '');
    const right = halves.length === 2 ? toHextets(halves[1] ?? '') : [];

    const fixed = [...left, ...right, ...embedded];
    if (fixed.some(Number.isNaN)) {
      return null;
    }

    if (halves.length === 1) {
      return fixed.length === 8 ? fixed : null;
    }

    const gap = 8 - fixed.length;
    if (gap < 1) {
      return null;
    }

    return [...left, ...new Array<number>(gap).fill(0), ...right, ...embedded];
  }

  /**
   * Validates that an IP address is not in a private/reserved range to prevent SSRF.
   * Blocks loopback, private, link-local, and cloud metadata ranges.
   *
   * IPv6 is range-checked on the parsed hextets rather than by string prefix, so
   * alternate spellings of the same address cannot slip through. Transition
   * mechanisms that embed an IPv4 address (IPv4-mapped, IPv4-compatible, 6to4,
   * NAT64, Teredo) are unwrapped and the embedded IPv4 re-validated — otherwise
   * e.g. `2002:a9fe:a9fe::` would reach 169.254.169.254 unblocked.
   */
  private static isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
      return WorkflowExecutionService.isPrivateIpv4(ip);
    }

    if (net.isIPv6(ip)) {
      const h = WorkflowExecutionService.expandIpv6(ip);
      if (!h) {
        return true;
      }

      const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
      const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      const topZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;

      // ::/128 unspecified and ::1/128 loopback
      if (topZero && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) {
        return true;
      }

      // ::ffff:0:0/96 IPv4-mapped and ::/96 IPv4-compatible (deprecated)
      if (topZero && (h5 === 0xffff || h5 === 0)) {
        return WorkflowExecutionService.isPrivateIpv4(v4(h6, h7));
      }

      // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64 (RFC 6052, RFC 8215)
      if (h0 === 0x0064 && h1 === 0xff9b) {
        return h2 === 0x0001 ? true : WorkflowExecutionService.isPrivateIpv4(v4(h6, h7));
      }

      // 2002::/16 6to4 (RFC 3056) — the embedded IPv4 is the tunnel endpoint
      if (h0 === 0x2002) {
        return WorkflowExecutionService.isPrivateIpv4(v4(h1, h2));
      }

      // 2001:0000::/32 Teredo (RFC 4380) — obfuscated endpoints, block outright
      if (h0 === 0x2001 && h1 === 0x0000) {
        return true;
      }

      return (
        (h0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
        (h0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
        (h0 & 0xff00) === 0xff00 || // ff00::/8 multicast
        (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) || // 100::/64 discard-only
        (h0 === 0x2001 && h1 === 0x0db8) // 2001:db8::/32 documentation
      );
    }

    // Unknown format — reject to be safe
    return true;
  }

  /**
   * SSRF-safe fetch. Resolves the hostname, validates the IP is not internal,
   * and manually follows redirects re-validating each hop.
   */
  private static async safeFetch(url: string, options: RequestInit): Promise<Response> {
    const MAX_REDIRECTS = 5;
    let currentUrl = url;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const parsed = new URL(currentUrl);

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Webhook URL scheme not allowed: ${parsed.protocol}`);
      }

      // WHATWG URL keeps the brackets on IPv6 literals (http://[::1]/)
      const hostname =
        parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
          ? parsed.hostname.slice(1, -1)
          : parsed.hostname;

      // An IP literal needs no resolution — validate it directly
      const address = net.isIP(hostname) ? hostname : (await dns.lookup(hostname)).address;

      if (WorkflowExecutionService.isPrivateIp(address)) {
        throw new Error(`Webhook URL resolves to a private/internal IP address: ${address}`);
      }

      const response = await fetch(currentUrl, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status >= 300 && response.status < 400) {
        // Plunk Lite: the redirect's own body is never read; release it
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Redirect with no Location header');
        }
        // Resolve relative redirects against the current URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      return response;
    }

    throw new Error('Too many redirects');
  }

  /**
   * WEBHOOK step - Call an external webhook.
   *
   * Renders `{{vars}}` in `url`, header values, and `body`. The variable
   * scope is a superset of the SEND_EMAIL scope: id, email, contact data,
   * execution context, and subscribe/unsubscribe/manage URLs — plus a
   * webhook-only `event` namespace exposing the trigger event payload.
   * `method` is intentionally NOT rendered — it must remain a literal
   * HTTP verb.
   */
  private static async executeWebhook(
    _step: WorkflowStep,
    execution: WorkflowExecutionWithRelations,
    _stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const {url, method, headers, body} = WorkflowStepConfigSchemas.webhook.parse(config);

    // Prepare webhook payload
    const contact = execution.contact;
    const contactData =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};
    const executionContext =
      execution.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
        ? (execution.context as Record<string, unknown>)
        : {};
    const context = execution.context || {};

    // Render scope: SEND_EMAIL's scope (id, email, contact data, execution
    // context, subscribe/unsubscribe/manage URLs) plus a webhook-only
    // `event` namespace carrying the trigger event payload. `method` is
    // intentionally NOT rendered — it must remain a literal HTTP verb.
    const variables = {
      id: contact.id,
      email: contact.email,
      ...contactData,
      ...executionContext,
      data: contactData,
      event: context,
      unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/${contact.id}`,
      subscribeUrl: `${DASHBOARD_URI}/subscribe/${contact.id}`,
      manageUrl: `${DASHBOARD_URI}/manage/${contact.id}`,
    };

    const renderedUrl = this.renderTemplate(url, variables);
    const renderedHeaders = headers
      ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, this.renderTemplate(value, variables)]))
      : undefined;
    const renderedBody = body ? this.renderJsonTemplate(body, variables) : undefined;

    const payload = renderedBody || {
      contact: {
        email: contact.email,
        subscribed: contact.subscribed,
        data: contactData,
      },
      workflow: {
        id: execution.workflow.id,
        name: execution.workflow.name,
      },
      execution: {
        id: execution.id,
        startedAt: execution.startedAt,
      },
      event: context, // Include event data that triggered the workflow
    };

    // Make HTTP request
    const response = await WorkflowExecutionService.safeFetch(renderedUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...renderedHeaders,
      },
      body: method !== 'GET' ? JSON.stringify(payload) : undefined,
    });

    // Plunk Lite: at most 64 KB of the answer, which is stored with the step: a huge response
    // filled the database and the worker's memory
    const {text: responseData, truncated} = await readCapped(response, MAX_WEBHOOK_RESPONSE_BYTES);
    let parsedResponse;
    try {
      parsedResponse = truncated ? responseData : JSON.parse(responseData);
    } catch {
      parsedResponse = responseData;
    }

    return {
      url: renderedUrl,
      method,
      statusCode: response.status,
      success: response.ok,
      response: parsedResponse,
      ...(truncated ? {truncated: true} : {}),
    };
  }

  /**
   * Helper: Recursively render template variables in any JSON-shaped value.
   * Strings are rendered, arrays/objects are walked, and non-string scalars
   * (numbers, booleans, null) are returned untouched.
   */
  private static renderJsonTemplate(value: unknown, variables: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      return this.renderTemplate(value, variables);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.renderJsonTemplate(item, variables));
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.renderJsonTemplate(child, variables);
      }
      return result;
    }
    return value;
  }

  /**
   * UPDATE_CONTACT step - Update contact data, subscription and static segments.
   *
   * Applied in a fixed order -- data, subscription, segment removals, segment additions -- and
   * segment events are tracked before the step returns, so a workflow they start (which runs
   * right away, in this same call) already sees the contact's new data. A segment that no longer
   * exists or is not static is skipped and reported, and the step carries on (D2).
   */
  private static async executeUpdateContact(
    _step: WorkflowStep,
    execution: WorkflowExecutionWithRelations,
    _stepExecution: WorkflowStepExecution,
    config: StepConfig,
  ): Promise<StepResult> {
    const {updates, subscriptionAction, segments} = WorkflowStepConfigSchemas.updateContact.parse(config);

    const contact = execution.contact;
    const currentData =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};

    const hasDataUpdates = updates && Object.keys(updates).length > 0;
    const newData = hasDataUpdates ? {...currentData, ...updates} : currentData;

    let desiredSubscribed =
      subscriptionAction === 'subscribe' ? true : subscriptionAction === 'unsubscribe' ? false : undefined;
    // A suppressed address is not subscribed by a workflow: the step goes on without it
    if (
      desiredSubscribed === true &&
      !contact.subscribed &&
      !(await SuppressionService.maySubscribe(execution.workflow.projectId, contact.email))
    ) {
      desiredSubscribed = undefined;
    }
    const subscriptionChanging = desiredSubscribed !== undefined && desiredSubscribed !== contact.subscribed;

    const updateData: Prisma.ContactUpdateInput = {};
    if (hasDataUpdates) {
      updateData.data = toPrismaJson(newData);
    }
    if (desiredSubscribed !== undefined) {
      // Written whenever the step asks for a subscription state, not only when the boolean
      // flips: a snoozed contact is already `subscribed = false`, so an `unsubscribe` action
      // on one changes nothing except the snooze -- which must still be cleared, or the sweep
      // would resubscribe someone the workflow just unsubscribed.
      // See SNOOZE_CLEARED_ON_WRITE in ContactService.
      updateData.subscribed = desiredSubscribed;
      updateData.snoozedUntil = null;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.contact.update({
        where: {id: contact.id},
        data: updateData,
      });
    }

    if (subscriptionChanging) {
      const {EventService} = await import('./EventService.js');
      await EventService.trackEvent(
        execution.workflow.projectId,
        desiredSubscribed ? 'contact.subscribed' : 'contact.unsubscribed',
        contact.id,
      );
    }

    const segmentChanges = await this.applySegmentChanges(
      execution.workflow.projectId,
      contact.id,
      segments ?? {add: [], remove: []},
    );

    return {
      updated:
        hasDataUpdates ||
        subscriptionChanging ||
        segmentChanges.segmentsAdded.length + segmentChanges.segmentsRemoved.length > 0,
      updates,
      newData,
      subscriptionAction,
      subscribed: desiredSubscribed ?? contact.subscribed,
      ...segmentChanges,
    };
  }

  /**
   * Remove the contact from, then add it to, static segments. Adding counts as an entry even
   * for a current member (D1).
   */
  private static async applySegmentChanges(
    projectId: string,
    contactId: string,
    segments: UpdateContactSegmentChanges,
  ): Promise<SegmentChangesResult> {
    const {SegmentMembershipService} = await import('./SegmentMembershipService.js');
    const result: SegmentChangesResult = {segmentsAdded: [], segmentsRemoved: [], skippedSegments: []};

    // Removals first. Repeated ids are dropped: each add is an entry of its own, so a repeated
    // id would fire the segment's entry, and start its workflows, once per repetition.
    const changes = [
      ...[...new Set(segments.remove)].map(segmentId => ({segmentId, add: false})),
      ...[...new Set(segments.add)].map(segmentId => ({segmentId, add: true})),
    ];

    for (const {segmentId, add} of changes) {
      try {
        if (add) {
          const {added} = await SegmentMembershipService.addMembers(projectId, segmentId, [contactId], {mode: 'await'});
          if (added > 0) result.segmentsAdded.push(segmentId);
        } else {
          const {removed} = await SegmentMembershipService.removeMembers(projectId, segmentId, [contactId], {
            mode: 'await',
          });
          if (removed > 0) result.segmentsRemoved.push(segmentId);
        }
      } catch (error) {
        // A missing, foreign or dynamic segment is a 404/400 from getStaticSegment: skip it (D2).
        // Anything else, such as a database error, fails the step as usual.
        if (!(error instanceof HttpException) || (error.code !== 404 && error.code !== 400)) {
          throw error;
        }
        signale.warn(`[WORKFLOW] Skipping segment ${segmentId} in an Update contact step: ${error.message}`);
        result.skippedSegments.push(segmentId);
      }
    }

    return result;
  }

  /**
   * Process next steps based on transitions
   */
  private static async processNextSteps(
    execution: WorkflowExecutionWithRelations,
    currentStep: WorkflowStepWithTransitions,
    stepResult: StepResult,
  ): Promise<void> {
    const transitions = currentStep.outgoingTransitions || [];

    if (transitions.length === 0) {
      // No more steps, complete the workflow
      // Plunk Lite: a cancelled or failed run keeps its status, and a waiting one is left to what
      // ends its wait (a late copy of a job must not complete it)
      await prisma.workflowExecution.updateMany({
        where: {id: execution.id, status: {notIn: UNMOVABLE_STATUSES}},
        data: {
          status: WorkflowExecutionStatus.COMPLETED,
          completedAt: new Date(),
          currentStepId: null,
        },
      });
      return;
    }

    // Find the appropriate transition based on conditions
    let nextStep = null;

    for (const transition of transitions) {
      const condition = transition.condition;

      // If no condition, always follow
      if (!condition) {
        nextStep = transition.toStep;
        break;
      }

      // If condition exists, evaluate it
      // For CONDITION steps, check the branch
      if (
        stepResult.branch &&
        typeof condition === 'object' &&
        condition !== null &&
        !Array.isArray(condition) &&
        'branch' in condition &&
        condition.branch === stepResult.branch
      ) {
        nextStep = transition.toStep;
        break;
      }

      // For other conditional logic
      if (this.evaluateTransitionCondition(condition, stepResult, execution)) {
        nextStep = transition.toStep;
        break;
      }
    }

    if (!nextStep) {
      // No valid transition found, complete workflow
      // Plunk Lite: a cancelled or failed run keeps its status, and a waiting one is left to what
      // ends its wait
      await prisma.workflowExecution.updateMany({
        where: {id: execution.id, status: {notIn: UNMOVABLE_STATUSES}},
        data: {
          status: WorkflowExecutionStatus.COMPLETED,
          completedAt: new Date(),
          currentStepId: null,
        },
      });
      return;
    }

    // Update current step and continue execution
    if (!(await this.moveRun(execution.id, nextStep.id))) {
      return;
    }

    // Process the next step
    // All steps are processed immediately - DELAY and WAIT_FOR_EVENT will pause the workflow internally
    await this.processStepExecution(execution.id, nextStep.id);
  }

  /**
   * Plunk Lite: a run resumed by an event failed. A step that failed has already failed its run and
   * alerted; anything else (moving on, before any step ran) fails it here, with the reason, so it
   * is not left RUNNING, its wait claimed, until the sweep fails it as interrupted.
   */
  private static async failResumedRun(execution: WorkflowExecutionWithRelations, error: unknown): Promise<void> {
    if (typeof error === 'object' && error !== null && handledFailures.has(error)) {
      return;
    }
    signale.error(`[WORKFLOW] Resuming execution ${execution.id} after its event failed:`, error);
    try {
      await WorkflowRecoveryService.failRun(execution, {
        error: error instanceof Error ? error.message : 'Resuming after the event failed',
        exitReason: 'Resuming after the event failed',
      });
    } catch (failError) {
      // The database is out too: the run stays as it was, and the alert of the failure is lost
      signale.error(`[WORKFLOW] Could not fail execution ${execution.id}:`, failError);
    }
  }

  /**
   * Plunk Lite: what a step stored as its output, to carry on from it without running it again
   */
  private static storedResult(output: Prisma.JsonValue): StepResult {
    return output && typeof output === 'object' && !Array.isArray(output) ? (output as StepResult) : {};
  }

  /**
   * Plunk Lite: end a wait -- its step WAITING → COMPLETED with `output`, and its run WAITING →
   * RUNNING -- in one transaction. Whoever claims both moves the run on; false for everyone else
   * (another copy of the event or timeout, or a run cancelled meanwhile).
   */
  private static async claimWait(
    stepExecutionId: string,
    executionId: string,
    stepId: string,
    output: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      return await prisma.$transaction(async tx => {
        const step = await tx.workflowStepExecution.updateMany({
          where: {id: stepExecutionId, status: StepExecutionStatus.WAITING},
          data: {status: StepExecutionStatus.COMPLETED, completedAt: new Date(), output: toPrismaJson(output)},
        });
        if (step.count === 0) {
          return false;
        }
        // Only while the run still waits on this very step, like a delay's end: a wait it left
        // behind (an old one still WAITING) must not pull it out of the one it is on now
        const run = await tx.workflowExecution.updateMany({
          where: {id: executionId, status: WorkflowExecutionStatus.WAITING, currentStepId: stepId},
          data: {status: WorkflowExecutionStatus.RUNNING},
        });
        if (run.count === 0) {
          throw new WaitNotClaimed();
        }
        return true;
      }, POOL_WAIT_TRANSACTION);
    } catch (error) {
      if (error instanceof WaitNotClaimed) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Plunk Lite: move a run on to its next step. Never a stopped run, nor a waiting one: a late copy
   * of a job walking steps it already did must not pull a run that waits further along out of its
   * wait (its delay's end or its event would then find it running and leave it)
   */
  private static async moveRun(executionId: string, nextStepId: string): Promise<boolean> {
    const {count} = await prisma.workflowExecution.updateMany({
      where: {id: executionId, status: {notIn: UNMOVABLE_STATUSES}},
      data: {status: WorkflowExecutionStatus.RUNNING, currentStepId: nextStepId},
    });

    if (count === 0) {
      signale.info(`[WORKFLOW] Execution ${executionId} is stopped, waiting or gone: not moving it on`);
    }

    return count > 0;
  }

  /**
   * Helper: Update an execution unless it has been stopped -- cancelled, or (Plunk Lite) failed
   * Returns false for a stopped (or deleted) execution, so a cancel that lands while a step runs, or
   * a run the recovery sweep failed, is never undone by the engine moving on
   */
  private static async updateUnlessStopped(
    executionId: string,
    data: Prisma.WorkflowExecutionUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const {count} = await prisma.workflowExecution.updateMany({
      where: {id: executionId, status: {notIn: STOPPED_STATUSES}},
      data,
    });

    if (count === 0) {
      signale.info(`[WORKFLOW] Execution ${executionId} was stopped or no longer exists, leaving it as it is`);
    }

    return count > 0;
  }

  /**
   * Helper: Render template with variables
   * Uses shared template rendering from @plunk/shared
   */
  private static renderTemplate(template: string, variables: Record<string, unknown>): string {
    return renderTemplate(template, variables);
  }

  /**
   * The value a condition compares: `segment.<id>` is whether the contact is in that segment
   * right now (a boolean); any other field is read from the contact and event data.
   */
  private static async conditionValue(
    field: string,
    fieldData: Record<string, unknown>,
    execution: WorkflowExecutionWithRelations,
  ): Promise<unknown> {
    if (field.startsWith('segment.')) {
      const {SegmentService} = await import('./SegmentService.js');
      return SegmentService.isMember(
        execution.workflow.projectId,
        field.slice('segment.'.length),
        execution.contact.id,
      );
    }
    return this.resolveField(field, fieldData);
  }

  /**
   * Helper: Resolve field value from object using dot notation
   */
  private static resolveField(field: string, data: Record<string, unknown>): unknown {
    // Handle legacy "contact.data.X" format by converting to "data.X"
    // The UI historically showed examples like "contact.data.plan" but the field structure
    // has "data" as a top-level key, not nested under "contact"
    let normalizedField = field;
    if (field.startsWith('contact.data.')) {
      normalizedField = field.substring(8); // Remove "contact." prefix, leaving "data.X"
    }

    const parts = normalizedField.split('.');
    let value: unknown = data;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Helper: Evaluate condition
   */
  private static evaluateCondition(actualValue: unknown, operator: string, expectedValue: unknown): boolean {
    switch (operator) {
      case 'equals':
        // equals can match null/undefined if expectedValue is also null/undefined
        return actualValue === expectedValue;
      case 'notEquals':
        // Match SegmentService behavior: only match when field exists and is not equal
        // Missing fields (undefined/null) do NOT match
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return actualValue !== expectedValue;
      case 'contains':
        // Return false if the value doesn't exist (undefined/null)
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return String(actualValue).includes(String(expectedValue));
      case 'notContains':
        // Match SegmentService behavior: only match when field exists and doesn't contain substring
        // Missing fields (undefined/null) do NOT match
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return !String(actualValue).includes(String(expectedValue));
      case 'greaterThan':
        // Numeric comparisons require field to exist
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return Number(actualValue) > Number(expectedValue);
      case 'lessThan':
        // Numeric comparisons require field to exist
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return Number(actualValue) < Number(expectedValue);
      case 'greaterThanOrEqual':
        // Numeric comparisons require field to exist
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return Number(actualValue) >= Number(expectedValue);
      case 'lessThanOrEqual':
        // Numeric comparisons require field to exist
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
        return Number(actualValue) <= Number(expectedValue);
      case 'exists':
        return actualValue !== undefined && actualValue !== null;
      case 'notExists':
        return actualValue === undefined || actualValue === null;
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }

  /**
   * Helper: Evaluate transition condition
   */
  private static evaluateTransitionCondition(
    _condition: Prisma.JsonValue,
    _stepResult: StepResult,
    _execution: WorkflowExecutionWithRelations,
  ): boolean {
    // Implement custom transition condition logic here
    // For now, return false as default
    return false;
  }
}
