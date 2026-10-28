import {CampaignAudienceType, Prisma, TemplateType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CampaignService} from '../CampaignService';

/** Plunk Lite: the send dialogs say how many unsubscribed contacts a TRANSACTIONAL campaign reaches */
describe('CampaignService.getSendAudience', () => {
  const prisma = getPrismaClient();
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

    expect(await CampaignService.getSendAudience(projectId, campaign.id)).toEqual({unsubscribed: 1});
  });

  it('counts none for a marketing campaign, which only reaches subscribed contacts', async () => {
    const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.ALL});

    expect(await CampaignService.getSendAudience(projectId, campaign.id)).toEqual({unsubscribed: 0});
  });

  it('keeps counting only the unsubscribed when the audience filter itself names subscribed', async () => {
    const campaign = await prisma.campaign.create({
      data: {
        projectId,
        name: 'Filtered',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hi@example.com',
        type: TemplateType.TRANSACTIONAL,
        audienceType: CampaignAudienceType.FILTERED,
        audienceCondition: {
          logic: 'OR',
          groups: [
            {filters: [{field: 'subscribed', operator: 'equals', value: true}]},
            {filters: [{field: 'subscribed', operator: 'equals', value: false}]},
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    expect(await CampaignService.getSendAudience(projectId, campaign.id)).toEqual({unsubscribed: 1});
  });
});
