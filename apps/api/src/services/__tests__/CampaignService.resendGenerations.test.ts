import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignAudienceType, CampaignStatus, EmailStatus} from '@plunk/db';
import type {CampaignBatchJobData} from '@plunk/types';

import {deleteUnsentCampaignEmails} from '../../jobs/campaign-cancel-cleanup-processor';
import {type EmailJob, processEmailJob} from '../../jobs/email-processor';
import {CampaignService} from '../CampaignService';
import {BillingLimitService} from '../BillingLimitService';
import {EmailService, POSSIBLY_SENT_NOTE} from '../EmailService';
import {QueueService} from '../QueueService';
import {sendRawEmail} from '../SESService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService')>()),
  sendRawEmail: vi.fn(),
}));

vi.mock('../MeterService.js', () => ({
  MeterService: {
    recordEmailSent: vi.fn().mockResolvedValue(undefined),
  },
}));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A campaign cancelled while one of its batches is still creating emails, and sent again.
 *
 * The batch checks the send it belongs to once, at its start. It used to go on creating the
 * emails of the earlier send after the cancel, and those outlived the cleanup: the second send
 * then counted them -- closing itself after its first batch, so the rest of the audience got
 * nothing, or never closing at all.
 */
describe('CampaignService - re-sending a cancelled campaign', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.mocked(sendRawEmail).mockReset();
    vi.mocked(sendRawEmail).mockImplementation(async () => ({messageId: `ses-${Math.random()}`}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const job = (emailId: string) =>
    ({data: {emailId}, attemptsMade: 0, opts: {attempts: 8}, updateData: vi.fn()}) as unknown as EmailJob;

  /** Run the email worker over the given emails, in that order */
  async function send(emailIds: string[]) {
    for (const id of emailIds) {
      await processEmailJob(job(id));
    }
  }

  const pendingIds = async (campaignId: string) =>
    (await prisma.email.findMany({where: {campaignId, status: EmailStatus.PENDING}})).map(email => email.id);

  async function sendingCampaign(contacts: number, totalRecipients = contacts) {
    await factories.createContacts(projectId, contacts, {subscribed: true});
    const campaign = await factories.createCampaign({
      projectId,
      status: CampaignStatus.SENDING,
      audienceType: CampaignAudienceType.ALL,
    });
    return prisma.campaign.update({
      where: {id: campaign.id},
      data: {sentAt: new Date(Date.now() - 60_000), totalRecipients},
    });
  }

  const batch = (campaignId: string, generation: number, limit: number): CampaignBatchJobData => ({
    campaignId,
    batchNumber: 1,
    offset: 0,
    limit,
    generation,
  });

  /**
   * Run a batch of the first send that sees the campaign cancelled and sent again (by a second
   * send stamping `sentAt`) after its check, while it reads its recipients. Returns the second
   * send's generation and the batches each send queued.
   */
  async function resendDuringFirstBatch(campaignId: string, first: number, limit: number) {
    const second = first + 60_000;
    const getRecipients = CampaignService['getRecipientsCursor'].bind(CampaignService);
    vi.spyOn(CampaignService as never, 'getRecipientsCursor').mockImplementationOnce(async (...args: unknown[]) => {
      const page = await (getRecipients as (...a: unknown[]) => Promise<unknown>)(...args);
      await prisma.campaign.update({where: {id: campaignId}, data: {sentAt: new Date(second)}});
      return page;
    });
    const queued: CampaignBatchJobData[] = [];
    vi.spyOn(QueueService, 'queueCampaignBatch').mockImplementation(async data => {
      queued.push(data);
      return {} as never;
    });

    await CampaignService.processBatch(batch(campaignId, first, limit));

    return {second, queued};
  }

  it('sends every batch of the second send, not just the first', async () => {
    const campaign = await sendingCampaign(4);
    const {second, queued} = await resendDuringFirstBatch(campaign.id, campaign.sentAt!.getTime(), 2);
    await send(await pendingIds(campaign.id));

    await CampaignService.processBatch(batch(campaign.id, second, 2));
    await send(await pendingIds(campaign.id));
    const afterFirstBatch = await prisma.campaign.findUnique({where: {id: campaign.id}});

    const next = queued.find(data => data.generation === second && data.batchNumber === 2);
    expect(next).toBeDefined();
    await CampaignService.processBatch(next!);
    await send(await pendingIds(campaign.id));

    const end = await prisma.campaign.findUnique({where: {id: campaign.id}});
    expect(afterFirstBatch?.status).toBe(CampaignStatus.SENDING);
    expect(end?.status).toBe(CampaignStatus.SENT);
    expect(end?.sentCount).toBe(4);
    expect(sendRawEmail).toHaveBeenCalledTimes(4);
  });

  it('closes the second send when its emails go out before anything of the first', async () => {
    const campaign = await sendingCampaign(3);
    const first = campaign.sentAt!.getTime();
    const {second} = await resendDuringFirstBatch(campaign.id, first, 500);
    const ofFirst = await pendingIds(campaign.id);
    // The first send's batch saw the second send at its first email, and created none
    expect(ofFirst).toEqual([]);

    await CampaignService.processBatch(batch(campaign.id, second, 500));
    const ofSecond = (await pendingIds(campaign.id)).filter(id => !ofFirst.includes(id));
    await send(ofSecond);
    await send(ofFirst);

    const end = await prisma.campaign.findUnique({where: {id: campaign.id}});
    const open = await prisma.email.count({
      where: {campaignId: campaign.id, status: {in: [EmailStatus.PENDING, EmailStatus.SENDING]}},
    });
    expect(open).toBe(0);
    expect(end?.status).toBe(CampaignStatus.SENT);
    expect(end?.sentCount).toBe(3);
  });

  it('reconciles the second send to its own audience while the queue is still loaded', async () => {
    const campaign = await sendingCampaign(3);
    const {second} = await resendDuringFirstBatch(campaign.id, campaign.sentAt!.getTime(), 500);

    // The second send's only batch is its last, and runs before the worker has got to anything
    await CampaignService.processBatch(batch(campaign.id, second, 500));
    const reconciled = await prisma.campaign.findUnique({where: {id: campaign.id}});
    await send(await pendingIds(campaign.id));

    const end = await prisma.campaign.findUnique({where: {id: campaign.id}});
    expect(reconciled?.totalRecipients).toBe(3);
    expect(end?.status).toBe(CampaignStatus.SENT);
    expect(end?.totalRecipients).toBe(3);
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(3);
  });

  it("stops a batch, without queueing the next one, once its send is no longer the campaign's", async () => {
    const campaign = await sendingCampaign(3);
    const generation = campaign.sentAt!.getTime();
    const queueEmail = EmailService.queueEmail.bind(EmailService);
    vi.spyOn(EmailService, 'queueEmail').mockImplementationOnce(async (...args) => {
      await queueEmail(...args);
      // Sent again after its first email: from here on, the batch is the earlier send's
      await prisma.campaign.update({where: {id: campaign.id}, data: {sentAt: new Date(generation + 60_000)}});
    });
    const queueBatch = vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue({} as never);

    await CampaignService.processBatch(batch(campaign.id, generation, 2));

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(1);
    expect(queueBatch).not.toHaveBeenCalled();
  });

  it('stops a last batch, without reconciling the total, once its campaign is cancelled', async () => {
    const campaign = await sendingCampaign(3, 7);
    const queueEmail = EmailService.queueEmail.bind(EmailService);
    vi.spyOn(EmailService, 'queueEmail').mockImplementationOnce(async (...args) => {
      await queueEmail(...args);
      // Cancelled after its first email: same send, but no longer sending
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.CANCELLED}});
    });

    await CampaignService.processBatch(batch(campaign.id, campaign.sentAt!.getTime(), 500));

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(1);
    expect((await prisma.campaign.findUnique({where: {id: campaign.id}}))?.totalRecipients).toBe(7);
  });

  it('has a cancel wait for an email being created, find it, and stop the batch', async () => {
    const campaign = await sendingCampaign(3);
    const holdsCurrentSend = CampaignService['holdsCurrentSend'].bind(CampaignService);
    let cancelling: ReturnType<typeof CampaignService.cancel> | undefined;
    let cancelledWhileLocked = false;
    vi.spyOn(CampaignService as never, 'holdsCurrentSend')
      .mockImplementationOnce(async (...args: Parameters<typeof holdsCurrentSend>) => {
        const holds = await holdsCurrentSend(...args);
        let done = false;
        cancelling = CampaignService.cancel(projectId, campaign.id).finally(() => {
          done = true;
        });
        // The cancel's UPDATE of the campaign waits for this transaction to end
        await sleep(300);
        cancelledWhileLocked = done;
        return holds;
      })
      .mockImplementationOnce(async (...args: Parameters<typeof holdsCurrentSend>) => {
        await cancelling;
        return holdsCurrentSend(...args);
      });

    await CampaignService.processBatch(batch(campaign.id, campaign.sentAt!.getTime(), 500));
    const {campaign: cancelled, revertPending} = await cancelling!;

    expect(cancelledWhileLocked).toBe(false);
    expect(cancelled.status).toBe(CampaignStatus.CANCELLED);
    // It saw the email the batch created, so the revert waits for the cleanup to remove it
    expect(revertPending).toBe(true);
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(1);
  });

  it('creates, counts and queues nothing for an email its guard turns down', async () => {
    const campaign = await sendingCampaign(1);
    const contact = (await prisma.contact.findFirst({where: {projectId}}))!;
    const incrementUsage = vi.spyOn(BillingLimitService, 'incrementUsage');
    const queueEmail = vi.spyOn(EmailService, 'queueEmail');

    const email = await EmailService.sendCampaignEmail(
      {projectId, contactId: contact.id, campaignId: campaign.id, subject: 's', body: 'b', from: 'hello@plunk.test'},
      async () => false,
    );

    expect(email).toBeNull();
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);
    expect(incrementUsage).not.toHaveBeenCalled();
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('does not let an email that failed during the cleanup into the draft', async () => {
    const campaign = await sendingCampaign(3);
    vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue({} as never);
    await CampaignService.processBatch(batch(campaign.id, campaign.sentAt!.getTime(), 500));
    const {revertPending} = await CampaignService.cancel(projectId, campaign.id);
    expect(revertPending).toBe(true);

    // A worker that read the campaign as sending before the cancel claims one email, so the
    // cleanup leaves it -- and SES then refuses it
    const claimed = (await prisma.email.findFirst({where: {campaignId: campaign.id}}))!;
    await prisma.email.update({where: {id: claimed.id}, data: {status: EmailStatus.SENDING}});
    await deleteUnsentCampaignEmails(campaign.id, new Date());
    await prisma.email.update({where: {id: claimed.id}, data: {status: EmailStatus.FAILED, error: 'Rejected'}});

    await expect(CampaignService.completeCancelRevert(projectId, campaign.id)).rejects.toThrow();
    expect((await prisma.campaign.findUnique({where: {id: campaign.id}}))?.status).toBe(CampaignStatus.CANCELLED);

    // The cleanup's retry
    await deleteUnsentCampaignEmails(campaign.id, new Date());
    expect(await CampaignService.completeCancelRevert(projectId, campaign.id)).toBe(CampaignStatus.DRAFT);
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);

    await CampaignService.startSending(projectId, campaign.id);
    const resent = (await prisma.campaign.findUnique({where: {id: campaign.id}}))!;
    await CampaignService.processBatch(batch(campaign.id, resent.sentAt!.getTime(), 500));
    expect((await prisma.campaign.findUnique({where: {id: campaign.id}}))?.totalRecipients).toBe(3);
  });

  describe('an email SES may have accepted', () => {
    // As the email worker and the recovery sweep leave one
    const possiblySent = [
      {error: `No answer from SES could be read; the email ${POSSIBLY_SENT_NOTE}: socket hang up`},
      {error: `Stopped while sending; ${POSSIBLY_SENT_NOTE}`},
      {error: 'Sent, but the send could not be recorded after every retry', messageId: 'ses-accepted'},
    ];

    async function campaignWithOneEmail() {
      const campaign = await sendingCampaign(1);
      vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue({} as never);
      await CampaignService.processBatch(batch(campaign.id, campaign.sentAt!.getTime(), 500));
      return {campaign, email: (await prisma.email.findFirst({where: {campaignId: campaign.id}}))!};
    }

    it.each(possiblySent)('keeps the campaign cancelled: $error', async failure => {
      const {campaign, email} = await campaignWithOneEmail();
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.FAILED, ...failure}});

      const {campaign: cancelled, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      expect(cancelled.status).toBe(CampaignStatus.CANCELLED);
      expect(revertPending).toBe(false);
    });

    it('is told apart from a failure with no error and no message id, which the cleanup deletes', async () => {
      const {campaign, email} = await campaignWithOneEmail();
      await CampaignService.cancel(projectId, campaign.id);
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.FAILED, error: null}});

      expect(await deleteUnsentCampaignEmails(campaign.id, new Date())).toBe(1);
      expect(await CampaignService.completeCancelRevert(projectId, campaign.id)).toBe(CampaignStatus.DRAFT);
    });

    it.each(possiblySent)('is not deleted by the cleanup: $error', async failure => {
      const {campaign, email} = await campaignWithOneEmail();
      const {revertPending} = await CampaignService.cancel(projectId, campaign.id);
      expect(revertPending).toBe(true);
      // Mid-send when the campaign was cancelled, and it ended without an answer from SES
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.FAILED, ...failure}});

      expect(await deleteUnsentCampaignEmails(campaign.id, new Date())).toBe(0);
      expect(await CampaignService.completeCancelRevert(projectId, campaign.id)).toBe(CampaignStatus.CANCELLED);
    });
  });
});
