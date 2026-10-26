import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignAudienceType, CampaignStatus, EmailStatus} from '@plunk/db';

import {CampaignService} from '../CampaignService';
import {EmailService} from '../EmailService';
import {QueueService} from '../QueueService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * A campaign batch can run more than once: BullMQ re-runs a batch whose worker was killed, and
 * retries one whose last step failed. Each run used to create a new email per contact, so every
 * contact in the batch was mailed again. Two sends that raced -- a double click, a manual send as
 * the schedule fired -- mailed the whole audience twice.
 */
describe('CampaignService - idempotent batches', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createContacts(projectId, 3, {subscribed: true});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sendingCampaign() {
    const campaign = await factories.createCampaign({
      projectId,
      status: CampaignStatus.SENDING,
      audienceType: CampaignAudienceType.ALL,
    });
    return prisma.campaign.update({where: {id: campaign.id}, data: {sentAt: new Date()}});
  }

  const batch = (campaignId: string, generation: number) => ({
    campaignId,
    batchNumber: 1,
    offset: 0,
    limit: 500,
    generation,
  });

  it('creates each email once when the same batch runs twice', async () => {
    const campaign = await sendingCampaign();
    const generation = campaign.sentAt!.getTime();

    await CampaignService.processBatch(batch(campaign.id, generation));
    await CampaignService.processBatch(batch(campaign.id, generation));

    const emails = await prisma.email.findMany({where: {campaignId: campaign.id}});
    expect(emails).toHaveLength(3);
    for (const email of emails) {
      expect(email.id).toBe(CampaignService.emailIdFor(campaign.id, generation, email.contactId));
    }
  });

  it('queues an email again when an earlier run created it but died before queueing it', async () => {
    const campaign = await sendingCampaign();
    const generation = campaign.sentAt!.getTime();
    await CampaignService.processBatch(batch(campaign.id, generation));
    const queueEmail = vi.spyOn(EmailService, 'queueEmail');

    await CampaignService.processBatch(batch(campaign.id, generation));

    // All three are still PENDING, so each is queued again (its job id deduplicates it)
    expect(queueEmail).toHaveBeenCalledTimes(3);
  });

  it('does not queue again an email that already left', async () => {
    const campaign = await sendingCampaign();
    const generation = campaign.sentAt!.getTime();
    await CampaignService.processBatch(batch(campaign.id, generation));
    await prisma.email.updateMany({where: {campaignId: campaign.id}, data: {status: EmailStatus.SENT}});
    const queueEmail = vi.spyOn(EmailService, 'queueEmail');

    await CampaignService.processBatch(batch(campaign.id, generation));

    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('drops a batch of an earlier send of the campaign', async () => {
    const campaign = await sendingCampaign();

    await CampaignService.processBatch(batch(campaign.id, campaign.sentAt!.getTime() - 60_000));

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
  });

  it('drops a batch queued before batches carried their send', async () => {
    const campaign = await sendingCampaign();
    const legacy = {campaignId: campaign.id, batchNumber: 1, offset: 0, limit: 500} as Parameters<
      typeof CampaignService.processBatch
    >[0];

    await CampaignService.processBatch(legacy);

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
  });

  it('starts one send when two start at once', async () => {
    const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.ALL});
    const queueBatch = vi.spyOn(QueueService, 'queueCampaignBatch');

    await Promise.all([
      CampaignService.startSending(projectId, campaign.id),
      CampaignService.startSending(projectId, campaign.id),
    ]);

    expect(queueBatch).toHaveBeenCalledTimes(1);
  });

  it('gives a later send of the same campaign batch jobs of its own', async () => {
    const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.ALL});
    const queueBatch = vi.spyOn(QueueService, 'queueCampaignBatch');

    await CampaignService.startSending(projectId, campaign.id);
    // As a cancel before anything was sent leaves it
    await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.DRAFT, sentAt: null}});
    await new Promise(resolve => setTimeout(resolve, 5));
    await CampaignService.startSending(projectId, campaign.id);

    const [first, second] = queueBatch.mock.calls.map(([data]) => data.generation);
    expect(first).not.toBe(second);
  });
});
