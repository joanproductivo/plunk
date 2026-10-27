import {CampaignStatus} from '@plunk/db';
import type {ScheduledCampaignJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {UnrecoverableError} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions/index.js';
import {CampaignService} from '../../services/CampaignService.js';
import {FailureAlertService} from '../../services/FailureAlertService.js';
import {processScheduledCampaign} from '../scheduled-processor.js';

/**
 * A scheduled campaign that cannot start must say so: only a campaign that left SCHEDULED
 * before its time is skipped quietly.
 */
describe('processScheduledCampaign', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  const jobFor = (campaignId: string) => ({data: {campaignId}}) as unknown as Job<ScheduledCampaignJobData>;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('alerts and stops retrying when a still-scheduled campaign cannot start', async () => {
    const campaign = await factories.createScheduledCampaign(projectId, new Date());
    vi.spyOn(CampaignService, 'startSending').mockRejectedValue(
      new HttpException(400, 'Referenced segment not found: gone'),
    );
    const alert = vi.spyOn(FailureAlertService, 'recordCampaignJob').mockResolvedValue();

    await expect(processScheduledCampaign(jobFor(campaign.id))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(alert).toHaveBeenCalledWith(campaign.id, expect.stringContaining('Referenced segment not found'));
  });

  it('leaves to its own job a campaign rescheduled for later', async () => {
    const campaign = await factories.createScheduledCampaign(projectId, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const start = vi.spyOn(CampaignService, 'startSending');

    await processScheduledCampaign(jobFor(campaign.id));

    expect(start).not.toHaveBeenCalled();
  });

  it('skips quietly a campaign that left SCHEDULED before it fired', async () => {
    const campaign = await factories.createScheduledCampaign(projectId, new Date());
    vi.spyOn(CampaignService, 'startSending').mockImplementation(async () => {
      // Cancelled back to a draft between the processor's check and the start
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.DRAFT}});
      throw new HttpException(400, 'Campaign is not in a sendable state');
    });
    const alert = vi.spyOn(FailureAlertService, 'recordCampaignJob').mockResolvedValue();

    await expect(processScheduledCampaign(jobFor(campaign.id))).resolves.toBeUndefined();

    expect(alert).not.toHaveBeenCalled();
  });
});
