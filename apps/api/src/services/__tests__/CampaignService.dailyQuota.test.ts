import {CampaignAudienceType, CampaignStatus, TemplateType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CampaignService} from '../CampaignService';
import {getDailyQuotaQuick} from '../SESService';

/**
 * Plunk Lite: a campaign that would not fit in what is left of SES's 24-hour quota is refused as it
 * starts, keeping 5 % for the day's transactional and workflow emails. (The test setup stands in for
 * SES's answer.)
 */
describe('CampaignService.send and the SES daily quota', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
    for (let i = 0; i < 10; i++) {
      await factories.createContact({projectId, subscribed: true});
    }
  });

  afterEach(() => {
    vi.mocked(getDailyQuotaQuick).mockReset();
    vi.mocked(getDailyQuotaQuick).mockResolvedValue(null);
  });

  const draft = () =>
    factories.createCampaign({projectId, status: CampaignStatus.DRAFT, audienceType: CampaignAudienceType.ALL});

  it('refuses a send past 95 % of the quota, and leaves the campaign a draft', async () => {
    vi.mocked(getDailyQuotaQuick).mockResolvedValue({max24HourSend: 100, sentLast24Hours: 90});
    const campaign = await draft();

    await expect(CampaignService.send(projectId, campaign.id)).rejects.toThrow(/Not enough SES quota/);

    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.DRAFT);
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
  });

  it('sends one that just fits', async () => {
    vi.mocked(getDailyQuotaQuick).mockResolvedValue({max24HourSend: 100, sentLast24Hours: 85});

    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);
  });

  it('sends when SES does not answer, or the quota has no limit', async () => {
    vi.mocked(getDailyQuotaQuick).mockResolvedValueOnce(null);
    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);

    vi.mocked(getDailyQuotaQuick).mockResolvedValueOnce({max24HourSend: -1, sentLast24Hours: 50_000});
    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);
  });
});

/** Plunk Lite: the send dialogs say how many unsubscribed contacts a TRANSACTIONAL campaign reaches */
describe('CampaignService.getAudience', () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
    await factories.createContact({projectId, subscribed: true});
    await factories.createContact({projectId, subscribed: true});
    await factories.createContact({projectId, subscribed: false});
  });

  it('counts the unsubscribed recipients of a transactional campaign', async () => {
    const campaign = await factories.createCampaign({
      projectId,
      type: TemplateType.TRANSACTIONAL,
      audienceType: CampaignAudienceType.ALL,
    });

    expect(await CampaignService.getAudience(projectId, campaign.id)).toEqual({total: 3, unsubscribed: 1});
  });

  it('counts none for a marketing campaign, which only reaches subscribed contacts', async () => {
    const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.ALL});

    expect(await CampaignService.getAudience(projectId, campaign.id)).toEqual({total: 2, unsubscribed: 0});
  });
});
