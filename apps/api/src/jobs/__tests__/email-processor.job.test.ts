import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {UnrecoverableError} from 'bullmq';

import {prisma as appPrisma} from '../../database/prisma';
import {CampaignService} from '../../services/CampaignService';
import {EventService} from '../../services/EventService';
import {SecurityService} from '../../services/SecurityService';
import {sendRawEmail} from '../../services/SESService';
import {type EmailJob, failAbandonedEmail, processEmailJob} from '../email-processor';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  sendRawEmail: vi.fn(),
}));

vi.mock('../../services/MeterService.js', () => ({
  MeterService: {
    recordEmailSent: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * The job body the email worker runs, driven directly.
 *
 * What it must guarantee: an email SES has not accepted is retried rather than lost, an email
 * SES has accepted is never sent again nor reported as failed, and nothing goes to a contact who
 * opted out after the email was queued.
 */
describe('processEmailJob', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.mocked(sendRawEmail).mockReset();
    vi.mocked(sendRawEmail).mockResolvedValue({messageId: 'ses-message-1'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A job double at a given attempt, recording what the processor stores on it */
  function makeJob(emailId: string, attemptsMade = 0, data: Partial<SendEmailJobData> = {}) {
    const job = {
      data: {emailId, ...data} as SendEmailJobData,
      attemptsMade,
      opts: {attempts: 8},
      updateData: vi.fn(async (next: SendEmailJobData) => {
        job.data = next;
      }),
    };
    return job as typeof job & EmailJob;
  }

  /** An error SES answered with, shaped as the AWS SDK throws it */
  function sesError(message: string, httpStatusCode = 400) {
    return Object.assign(new Error(message), {$metadata: {httpStatusCode}});
  }

  async function pendingEmail(
    options: {
      subscribed?: boolean;
      sourceType?: EmailSourceType;
      campaign?: {id: string; sentAt: Date | null};
      id?: string;
    } = {},
  ) {
    const contact = await factories.createContact({projectId, subscribed: options.subscribed ?? true});
    const {campaign} = options;
    return prisma.email.create({
      data: {
        // A campaign email carries the id its send derives, as `processBatch` creates it
        id:
          options.id ??
          (campaign ? CampaignService.emailIdFor(campaign.id, campaign.sentAt!.getTime(), contact.id) : undefined),
        projectId,
        contactId: contact.id,
        campaignId: campaign?.id ?? null,
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'hello@plunk.test',
        sourceType: options.sourceType ?? EmailSourceType.CAMPAIGN,
        status: EmailStatus.PENDING,
      },
    });
  }

  async function sendingCampaign() {
    const campaign = await factories.createCampaign({projectId});
    return prisma.campaign.update({
      where: {id: campaign.id},
      data: {status: CampaignStatus.SENDING, sentAt: new Date(), totalRecipients: 1},
    });
  }

  it('sends a pending email and records it', async () => {
    const email = await pendingEmail();

    await processEmailJob(makeJob(email.id));

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.SENT);
    expect(row?.messageId).toBe('ses-message-1');
    expect(sendRawEmail).toHaveBeenCalledTimes(1);
  });

  describe('before SES accepts the email', () => {
    it('puts it back to pending and rethrows while attempts remain', async () => {
      const email = await pendingEmail();
      vi.mocked(sendRawEmail).mockRejectedValue(sesError('Throttling: Maximum sending rate exceeded'));

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toThrow('Throttling');

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.PENDING);
    });

    it('puts it back to pending when the connection to SES was never made', async () => {
      const email = await pendingEmail();
      vi.mocked(sendRawEmail).mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED', $metadata: {attempts: 1}}),
      );

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toThrow('ECONNREFUSED');

      expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.PENDING);
    });

    it('does not resend an email SES answered 200 for, when the answer could not be read', async () => {
      const email = await pendingEmail();
      // The SDK reports a body it could not read or parse with the status SES answered
      vi.mocked(sendRawEmail).mockRejectedValue(sesError('Deserialization error', 200));

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toBeInstanceOf(UnrecoverableError);

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      expect(row?.error).toMatch(/may have been sent/);
    });

    it('sends it on the retry', async () => {
      const email = await pendingEmail();
      vi.mocked(sendRawEmail).mockRejectedValueOnce(sesError('Throttling'));

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toThrow();
      await processEmailJob(makeJob(email.id, 1));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENT);
      expect(sendRawEmail).toHaveBeenCalledTimes(2);
    });

    it('marks it failed on the last attempt and finalizes its campaign', async () => {
      const campaign = await sendingCampaign();
      const email = await pendingEmail({campaign});
      vi.mocked(sendRawEmail).mockRejectedValue(sesError('MessageRejected'));

      await expect(processEmailJob(makeJob(email.id, 7))).rejects.toThrow('MessageRejected');

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      const updated = await prisma.campaign.findUnique({where: {id: campaign.id}});
      expect(updated?.status).toBe(CampaignStatus.SENT);
    });

    it('does not resend an email whose connection to SES was lost, since SES may have it', async () => {
      const email = await pendingEmail();
      // A reset carries no HTTP status: SES may have accepted the email before the answer was lost
      vi.mocked(sendRawEmail).mockRejectedValue(Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}));

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toBeInstanceOf(UnrecoverableError);

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      expect(row?.error).toMatch(/may have been sent/);
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });

    it('does not retry an email blocked for a policy violation', async () => {
      const email = await pendingEmail();
      vi.spyOn(SecurityService, 'checkPhishingContent').mockResolvedValue({
        shouldDisable: true,
        confidence: 99,
      } as Awaited<ReturnType<typeof SecurityService.checkPhishingContent>>);
      vi.spyOn(SecurityService, 'disableProjectForPhishing').mockResolvedValue(undefined as never);

      await expect(processEmailJob(makeJob(email.id, 0))).rejects.toBeInstanceOf(UnrecoverableError);

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      expect(sendRawEmail).not.toHaveBeenCalled();
    });
  });

  describe('after SES accepts the email', () => {
    it('keeps it sent when tracking the event fails', async () => {
      const email = await pendingEmail();
      vi.spyOn(EventService, 'trackEvent').mockRejectedValue(new Error('workflow blew up'));

      await processEmailJob(makeJob(email.id, 0));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENT);
      expect(row?.messageId).toBe('ses-message-1');
    });

    it('keeps what SES returned on the job, and a retry records it without sending again', async () => {
      const email = await pendingEmail();
      const job = makeJob(email.id, 0);
      // The claim (PENDING -> SENDING) goes through; the stamp then fails twice: in the
      // attempt, and in the second try from the catch
      const claim = appPrisma.email.updateMany.bind(appPrisma.email);
      const updateMany = vi
        .spyOn(appPrisma.email, 'updateMany')
        .mockImplementationOnce(args => claim(args))
        .mockRejectedValueOnce(new Error('database down'))
        .mockRejectedValueOnce(new Error('database down'));

      await expect(processEmailJob(job)).rejects.toThrow('database down');
      expect(job.data.accepted).toEqual({messageId: 'ses-message-1', subject: 'Hello'});

      updateMany.mockRestore();
      await processEmailJob(makeJob(email.id, 1, job.data));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENT);
      expect(row?.messageId).toBe('ses-message-1');
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscription at send time', () => {
    it('does not send a campaign email to a contact who unsubscribed after it was queued', async () => {
      const campaign = await sendingCampaign();
      const email = await pendingEmail({campaign});
      await prisma.contact.update({where: {id: email.contactId}, data: {subscribed: false}});

      await processEmailJob(makeJob(email.id));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      expect(row?.error).toBe('Contact is unsubscribed');
      expect(sendRawEmail).not.toHaveBeenCalled();
      const updated = await prisma.campaign.findUnique({where: {id: campaign.id}});
      expect(updated?.status).toBe(CampaignStatus.SENT);
    });

    it('still sends a transactional email to an unsubscribed contact', async () => {
      const email = await pendingEmail({subscribed: false, sourceType: EmailSourceType.TRANSACTIONAL});

      await processEmailJob(makeJob(email.id));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENT);
    });

    it('does not send a marketing template through the transactional API to an unsubscribed contact', async () => {
      const template = await factories.createTemplate({projectId, type: 'MARKETING'});
      const email = await pendingEmail({subscribed: false, sourceType: EmailSourceType.TRANSACTIONAL});
      await prisma.email.update({where: {id: email.id}, data: {templateId: template.id}});

      await processEmailJob(makeJob(email.id));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      expect(sendRawEmail).not.toHaveBeenCalled();
    });

    it('still sends a workflow email to a custom recipient', async () => {
      const email = await pendingEmail({subscribed: false, sourceType: EmailSourceType.WORKFLOW});
      await prisma.email.update({
        where: {id: email.id},
        data: {headers: {'X-Plunk-Recipient-Override': 'someone@else.test'}},
      });

      await processEmailJob(makeJob(email.id));

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENT);
    });
  });

  describe('a job out of attempts', () => {
    it('fails an email still pending and finalizes its campaign', async () => {
      const campaign = await sendingCampaign();
      const email = await pendingEmail({campaign});

      await failAbandonedEmail(email.id);

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.FAILED);
      const updated = await prisma.campaign.findUnique({where: {id: campaign.id}});
      expect(updated?.status).toBe(CampaignStatus.SENT);
    });

    it('leaves an email in SENDING alone, because SES may have it', async () => {
      const email = await pendingEmail();
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.SENDING}});

      await failAbandonedEmail(email.id);

      const row = await prisma.email.findUnique({where: {id: email.id}});
      expect(row?.status).toBe(EmailStatus.SENDING);
    });
  });

  it('does not send an email left from an earlier send of the same campaign', async () => {
    const campaign = await sendingCampaign();
    // Created under a send that was cancelled: its id derives from another generation
    const stale = await pendingEmail({
      campaign: {id: campaign.id, sentAt: new Date(campaign.sentAt!.getTime() - 60_000)},
    });

    await processEmailJob(makeJob(stale.id));

    const row = await prisma.email.findUnique({where: {id: stale.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(row?.error).toBe('Stale campaign generation');
    expect(sendRawEmail).not.toHaveBeenCalled();
  });
});
