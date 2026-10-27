import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';

import {emailQueue, QueueService} from '../../services/QueueService';
import {sweepStuckEmails} from '../email-recovery-sweep-processor';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * The sweep settles emails nothing else will move: PENDING without a job, SENDING without a run.
 * What it must never do is send something twice or send something stale.
 */
describe('sweepStuckEmails', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  const now = new Date();
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000);

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await emailQueue.obliterate({force: true});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function stuckEmail(status: EmailStatus, age: Date, campaignId?: string) {
    const contact = await factories.createContact({projectId});
    const email = await prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId: campaignId ?? null,
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'hello@plunk.test',
        sourceType: EmailSourceType.CAMPAIGN,
        status,
        createdAt: age,
      },
    });
    // `updatedAt` is stamped by Prisma on create; the sweep reads it for SENDING rows
    await prisma.$executeRaw`UPDATE "emails" SET "updatedAt" = ${age} WHERE "id" = ${email.id}`;
    return email;
  }

  /** The email's job, as the sweep reads it */
  function jobInState(state: string, data: Record<string, unknown> = {}) {
    const job = {getState: vi.fn().mockResolvedValue(state), data, retry: vi.fn().mockResolvedValue(undefined)};
    vi.spyOn(emailQueue, 'getJob').mockResolvedValue(job as never);
    return job;
  }

  it('leaves alone a pending email whose prioritized job is still waiting its turn', async () => {
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(30));
    // A real job: every email job carries a priority, so it waits as `prioritized`
    await QueueService.queueEmail(email.id, EmailSourceType.CAMPAIGN);
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    await sweepStuckEmails(now);

    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.PENDING);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('queues again a pending email that has no job', async () => {
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(30));
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    const result = await sweepStuckEmails(now);

    expect(result.requeued).toBe(1);
    expect(queueEmail).toHaveBeenCalledWith(email.id, EmailSourceType.CAMPAIGN);
  });

  it('does not touch a pending email younger than fifteen minutes', async () => {
    await stuckEmail(EmailStatus.PENDING, minutesAgo(5));
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    await sweepStuckEmails(now);

    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('fails a pending email whose job ran out of attempts, and finishes its campaign', async () => {
    const campaign = await factories.createCampaign({projectId});
    await prisma.campaign.update({
      where: {id: campaign.id},
      data: {status: CampaignStatus.SENDING, sentAt: minutesAgo(40), totalRecipients: 1},
    });
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(30), campaign.id);
    jobInState('failed');

    await sweepStuckEmails(now);

    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.FAILED);
    expect((await prisma.campaign.findUnique({where: {id: campaign.id}}))?.status).toBe(CampaignStatus.SENT);
  });

  it('fails, never resends, a pending email whose job already finished', async () => {
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(30));
    jobInState('completed');
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    await sweepStuckEmails(now);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('expires a pending email older than two days instead of sending it', async () => {
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(49 * 60));
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    await sweepStuckEmails(now);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(row?.error).toBe('Expired, never sent');
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('does not queue an email of a disabled project', async () => {
    const email = await stuckEmail(EmailStatus.PENDING, minutesAgo(30));
    await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
    const queueEmail = vi.spyOn(QueueService, 'queueEmail');

    await sweepStuckEmails(now);

    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.FAILED);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('retries the job of an email SES accepted, so it is recorded rather than resent', async () => {
    const email = await stuckEmail(EmailStatus.SENDING, minutesAgo(30));
    const job = jobInState('failed', {emailId: email.id, accepted: {messageId: 'ses-1', subject: 'Hello'}});

    const result = await sweepStuckEmails(now);

    expect(result.retried).toBe(1);
    expect(job.retry).toHaveBeenCalledWith('failed');
    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.SENDING);
  });

  it('leaves alone a sending email whose job is still running', async () => {
    const email = await stuckEmail(EmailStatus.SENDING, minutesAgo(30));
    jobInState('active');

    await sweepStuckEmails(now);

    expect((await prisma.email.findUnique({where: {id: email.id}}))?.status).toBe(EmailStatus.SENDING);
  });

  it('fails as possibly sent a sending email with no run behind it', async () => {
    const email = await stuckEmail(EmailStatus.SENDING, minutesAgo(30));

    await sweepStuckEmails(now);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.status).toBe(EmailStatus.FAILED);
    expect(row?.error).toMatch(/may have been sent/);
  });
});
