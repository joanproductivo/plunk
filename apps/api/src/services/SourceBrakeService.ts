import {CampaignStatus, WorkflowExecutionStatus} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

import {CampaignService} from './CampaignService.js';
import {FailureAlertService} from './FailureAlertService.js';
import type {RateData} from './ReputationPolicy.js';
import {ReputationPolicy} from './ReputationPolicy.js';
import {SECURITY_THRESHOLDS} from './SecurityService.js';
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

export class SourceBrakeService {
  /** The source of an email, as a brake knows it; undefined for a transactional one */
  public static async sourceOf(email: {
    campaignId: string | null;
    workflowExecutionId: string | null;
  }): Promise<string | undefined> {
    if (email.campaignId) {
      return `campaign:${email.campaignId}`;
    }
    if (email.workflowExecutionId) {
      const execution = await prisma.workflowExecution.findUnique({
        where: {id: email.workflowExecutionId},
        select: {workflowId: true},
      });
      return execution ? `workflow:${execution.workflowId}` : undefined;
    }
    return undefined;
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

    // It may have finished or been cancelled while the rates were counted
    const current = await prisma.campaign.findUnique({where: {id: campaignId}, select: {status: true}});
    if (current?.status !== CampaignStatus.SENDING) {
      return;
    }
    try {
      await CampaignService.cancel(projectId, campaignId);
    } catch (error) {
      // Gone, or no longer cancellable: nothing left to stop
      if (error instanceof HttpException && (error.code === 400 || error.code === 404)) {
        return;
      }
      throw error;
    }

    signale.warn(`[BRAKE] Campaign ${campaignId} of project ${projectId} cancelled: ${reason}`);
    await FailureAlertService.record(projectId, {
      sourceKey: `brake:campaign:${campaignId}`,
      label: campaign.name,
      error: `Stopped after ${reason}. Duplicate the campaign to send it again: it will go to its whole audience.`,
    });
  }

  /**
   * Disables a workflow whose emails of the last day bounce or are reported too often, as the
   * dashboard does, and cancels its executions that have not sent an email yet. The ones that have
   * go on, as they do whenever a workflow is disabled.
   */
  private static async brakeWorkflow(projectId: string, workflowId: string): Promise<void> {
    const workflow = await prisma.workflow.findFirst({
      where: {id: workflowId, projectId},
      select: {enabled: true, name: true},
    });
    if (!workflow?.enabled) {
      return;
    }

    const since = new Date(Date.now() - WORKFLOW_WINDOW_MS);
    const reason = brakeReason(await ReputationPolicy.rates({projectId, workflowId, since}), WORKFLOW_MIN_SENT);
    if (!reason) {
      return;
    }

    await WorkflowService.update(projectId, workflowId, {enabled: false});
    const cancelled = await prisma.workflowExecution.updateMany({
      where: {
        workflowId,
        status: {in: [WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING]},
        emails: {none: {}},
      },
      data: {
        status: WorkflowExecutionStatus.CANCELLED,
        completedAt: new Date(),
        exitReason: 'Workflow disabled for its bounces or complaints',
      },
    });

    signale.warn(`[BRAKE] Workflow ${workflowId} of project ${projectId} disabled: ${reason}`);
    await FailureAlertService.record(projectId, {
      sourceKey: `brake:workflow:${workflowId}`,
      label: workflow.name,
      error: `Disabled after ${reason} in the last 24 hours, and ${cancelled.count} of its runs that had not sent an email yet were cancelled. Check where its contacts come from before enabling it again.`,
    });
  }
}
