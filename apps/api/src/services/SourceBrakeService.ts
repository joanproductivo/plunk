import {CampaignStatus, EmailStatus, WorkflowExecutionStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

import {CampaignService} from './CampaignService.js';
import {FailureAlertService} from './FailureAlertService.js';
import {sourceKeyOf} from './failureSources.js';
import type {RateData} from './ReputationPolicy.js';
import {ReputationPolicy} from './ReputationPolicy.js';
import {SECURITY_THRESHOLDS} from './SecurityService.js';
import {WorkflowEnabledAt} from './WorkflowEnabledAt.js';
import {WorkflowService} from './WorkflowService.js';

/**
 * Plunk Lite: stopping the campaign or workflow whose emails bounce or are reported as spam, before
 * the project's rates get bad enough to stop everything it sends. A promotion that reaches a batch
 * of mistyped addresses stops on its own; the transactional emails keep going.
 *
 * Sources are named as alerts name them: `campaign:<id>`, `workflow:<id>`.
 */

/** Sent emails a campaign or workflow needs before its rates mean anything */
const CAMPAIGN_MIN_SENT = 100;
const WORKFLOW_MIN_SENT = 50;
/** A workflow is judged on the last day of its emails, since it sends for as long as it is enabled */
const WORKFLOW_WINDOW_MS = 86_400_000;

/**
 * Why a source's emails are bad enough to stop it, or undefined: past Plunk's 7-day critical rates,
 * with as many bounces or complaints as those ask for
 */
function brakeReason(rates: RateData, minSent: number): string | undefined {
  if (rates.total < minSent) {
    return undefined;
  }
  if (
    rates.bounces >= SECURITY_THRESHOLDS.MIN_BOUNCES_FOR_CRITICAL &&
    rates.bounceRate >= SECURITY_THRESHOLDS.BOUNCE_7DAY_CRITICAL
  ) {
    return `${rates.bounces} bounces in ${rates.total} emails sent (${rates.bounceRate.toFixed(1)}%)`;
  }
  if (
    rates.complaints >= SECURITY_THRESHOLDS.MIN_COMPLAINTS_FOR_CRITICAL &&
    rates.complaintRate >= SECURITY_THRESHOLDS.COMPLAINT_7DAY_CRITICAL
  ) {
    return `${rates.complaints} spam complaints in ${rates.total} emails sent (${rates.complaintRate.toFixed(2)}%)`;
  }
  return undefined;
}

const BRAKE_EXIT_REASON = 'Workflow disabled for its bounces or complaints';

export class SourceBrakeService {
  /** The source of an email, as a brake knows it; undefined for a transactional one */
  public static async sourceOf(email: {
    campaignId: string | null;
    workflowExecutionId: string | null;
  }): Promise<string | undefined> {
    const {sourceKey} = await sourceKeyOf(email);
    return sourceKey === 'transactional' ? undefined : sourceKey;
  }

  /** The campaigns of the project still sending, for when the sources of the last events are lost */
  public static async sendingCampaigns(projectId: string): Promise<string[]> {
    const campaigns = await prisma.campaign.findMany({
      where: {projectId, status: CampaignStatus.SENDING},
      select: {id: true},
    });
    return campaigns.map(campaign => `campaign:${campaign.id}`);
  }

  /** Stops each source past its rates. Throws the first error once every source was tried. */
  public static async brake(projectId: string, sources: string[]): Promise<void> {
    let firstError: unknown;
    for (const source of new Set(sources)) {
      const [kind, id] = source.split(':');
      try {
        if (kind === 'campaign' && id) {
          await this.brakeCampaign(projectId, id);
        } else if (kind === 'workflow' && id) {
          await this.brakeWorkflow(projectId, id);
        }
      } catch (error) {
        signale.error(`[BRAKE] Could not judge ${source} of project ${projectId}:`, error);
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  /**
   * Cancels a campaign still sending whose emails sent so far bounce or are reported too often. A
   * cancelled campaign cannot be sent again (it is not a draft): it has to be duplicated, and the
   * copy goes to the whole audience.
   */
  private static async brakeCampaign(projectId: string, campaignId: string): Promise<void> {
    const campaign = await prisma.campaign.findFirst({
      where: {id: campaignId, projectId},
      select: {status: true, name: true},
    });
    if (campaign?.status !== CampaignStatus.SENDING) {
      return;
    }

    const reason = brakeReason(await ReputationPolicy.rates({projectId, campaignId}), CAMPAIGN_MIN_SENT);
    if (!reason) {
      return;
    }

    // Stopped here only if it is still sending: it may have finished, or been cancelled by someone
    // else, while the rates were counted, and then this brake did not stop it
    const stopped = await prisma.campaign.updateMany({
      where: {id: campaignId, status: CampaignStatus.SENDING},
      data: {status: CampaignStatus.CANCELLED},
    });
    if (stopped.count !== 1) {
      return;
    }

    // The rest of a cancel -- what is left of the send, whether it can go back to the drafts -- as
    // `cancel` repairs a cancelled campaign
    let cancelError: unknown;
    try {
      await CampaignService.cancel(projectId, campaignId);
    } catch (error) {
      // Deleted meanwhile: nothing left to tidy up
      if (!(error instanceof HttpException && error.code === 404)) {
        cancelError = error;
      }
    }

    signale.warn(`[BRAKE] Campaign ${campaignId} of project ${projectId} cancelled: ${reason}`);
    await FailureAlertService.record(projectId, {
      sourceKey: `brake:campaign:${campaignId}`,
      label: campaign.name,
      error: `Stopped after ${reason}. Duplicate the campaign to send it again: it will go to its whole audience.`,
    });
    if (cancelError) {
      throw cancelError;
    }
  }

  /**
   * Disables a workflow whose emails of the last day bounce or are reported too often, as the
   * dashboard does, and cancels its executions that have not sent an email yet, with the emails
   * they queued that have not gone out. The ones that have sent one go on, as they do whenever a
   * workflow is disabled.
   *
   * The day counts from the last time the workflow was enabled, if that is later: the bounces that
   * stopped it must not stop it again as soon as it is enabled.
   */
  private static async brakeWorkflow(projectId: string, workflowId: string): Promise<void> {
    const workflow = await prisma.workflow.findFirst({
      where: {id: workflowId, projectId},
      select: {enabled: true, name: true},
    });
    if (!workflow?.enabled) {
      return;
    }

    const dayAgo = new Date(Date.now() - WORKFLOW_WINDOW_MS);
    const enabledAt = await WorkflowEnabledAt.get(workflowId);
    const since = enabledAt && enabledAt > dayAgo ? enabledAt : dayAgo;
    const reason = brakeReason(await ReputationPolicy.rates({projectId, workflowId, since}), WORKFLOW_MIN_SENT);
    if (!reason) {
      return;
    }

    await WorkflowService.update(projectId, workflowId, {enabled: false});
    const cancelled = await prisma.workflowExecution.updateMany({
      where: {
        workflowId,
        status: {in: [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING]},
        emails: {none: {sentAt: {not: null}}},
      },
      data: {
        status: WorkflowExecutionStatus.CANCELLED,
        completedAt: new Date(),
        exitReason: BRAKE_EXIT_REASON,
      },
    });
    // Their emails still waiting in the queue: the email job sends only a PENDING one, and one
    // already being sent goes out
    await prisma.email.updateMany({
      where: {
        status: EmailStatus.PENDING,
        workflowExecution: {workflowId, status: WorkflowExecutionStatus.CANCELLED, exitReason: BRAKE_EXIT_REASON},
      },
      data: {status: EmailStatus.FAILED, error: BRAKE_EXIT_REASON},
    });

    signale.warn(`[BRAKE] Workflow ${workflowId} of project ${projectId} disabled: ${reason}`);
    await FailureAlertService.record(projectId, {
      sourceKey: `brake:workflow:${workflowId}`,
      label: workflow.name,
      error: `Disabled after ${reason} in the last 24 hours, and ${cancelled.count} of its runs that had not sent an email yet were cancelled. Check where its contacts come from before enabling it again.`,
    });
  }
}
