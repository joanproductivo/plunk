import {CampaignAudienceType, CampaignStatus} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CampaignService} from '../CampaignService';
import {getDailyQuotaQuick} from '../SESService';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  getDailyQuotaQuick: vi.fn(async () => null),
}));

/**
 * Plunk Lite: a campaign that would not fit in what is left of SES's 24-hour quota is refused as it
 * starts, keeping 5 % for the day's transactional and workflow emails
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

  it('counts what the campaigns still sending, in any project, have left to send', async () => {
    const other = (await factories.createUserWithProject()).project.id;
    // As a send leaves it: sentCount is only written as it finalizes, the progress is in Redis
    const sending = await prisma.campaign.create({
      data: {
        projectId: other,
        name: 'Still sending',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hi@example.com',
        status: CampaignStatus.SENDING,
        totalRecipients: 60,
        sentCount: 0,
      },
    });
    for (let i = 0; i < 30; i++) {
      await CampaignService.countCampaignSent(sending.id);
    }
    // SES counts the 30 already sent
    vi.mocked(getDailyQuotaQuick).mockResolvedValue({max24HourSend: 100, sentLast24Hours: 50});

    // 50 sent + 30 on their way + 10 for this one = 90, within 95
    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);
    // ...and the next one 50 + (30 + 10) + 10 = 100, past 95
    await expect(CampaignService.send(projectId, (await draft()).id)).rejects.toThrow(
      /40 more are on their way in 2 campaigns still sending/,
    );
  });

  it('sends when SES does not answer, or the quota has no limit', async () => {
    vi.mocked(getDailyQuotaQuick).mockResolvedValueOnce(null);
    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);

    vi.mocked(getDailyQuotaQuick).mockResolvedValueOnce({max24HourSend: -1, sentLast24Hours: 50_000});
    expect((await CampaignService.send(projectId, (await draft()).id)).status).toBe(CampaignStatus.SENDING);
  });
});
