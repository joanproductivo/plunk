import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {deleteUnsentCampaignEmails} from '../../jobs/campaign-cancel-cleanup-processor';
import {redis} from '../../database/redis';
import {CampaignService} from '../CampaignService';
import {Keys} from '../keys';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Cancelling is two operations behind one button, and which one runs is decided by whether a
 * single email ever reached SES. The distinction is not observable from the campaign row --
 * `startSending` stamps `sentAt` on the campaign before the first batch runs, and `processBatch`
 * creates every `Email` row PENDING long before any of them is dispatched -- so these tests
 * pin the predicate to `Email.sentAt`, which is the only thing that marks a message as gone.
 */
describe('CampaignService - cancel', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** An `Email` row as `processBatch` leaves it: queued for the worker, nothing sent. */
  async function queueEmail(campaignId: string, overrides: {status?: EmailStatus; sentAt?: Date} = {}) {
    const contact = await factories.createContact({projectId, email: `c-${Date.now()}-${Math.random()}@plunk.test`});
    return prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId,
        subject: 'Cancel',
        body: '<p>x</p>',
        from: 'hello@plunk.test',
        sourceType: 'CAMPAIGN',
        status: overrides.status ?? EmailStatus.PENDING,
        sentAt: overrides.sentAt ?? null,
      },
    });
  }

  describe('when nothing has been sent', () => {
    it('returns a scheduled campaign to an editable draft', async () => {
      const campaign = await factories.createScheduledCampaign({
        projectId,
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
      });

      const {campaign: result, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      // No rows were ever created, so there is nothing to clean up and no wait.
      expect(result.status).toBe(CampaignStatus.DRAFT);
      expect(revertPending).toBe(false);
      // A stale schedule would have the campaign render as due in the past.
      expect(result.scheduledFor).toBeNull();
    });

    it('holds a campaign with rows to clear at CANCELLED and defers the revert', async () => {
      const campaign = await factories.createCampaign({
        projectId,
        status: CampaignStatus.SENDING,
      });
      await queueEmail(campaign.id);
      await queueEmail(campaign.id);

      const {campaign: result, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      // Deliberately not DRAFT yet. `send` refuses a CANCELLED campaign, and that is
      // what stops a second send starting while the first send's rows are still there
      // to be counted by it.
      expect(result.status).toBe(CampaignStatus.CANCELLED);
      expect(revertPending).toBe(true);
    });

    it('promotes to draft once the cleanup has run', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await queueEmail(campaign.id);

      await CampaignService.cancel(projectId, campaign.id);
      await prisma.email.deleteMany({where: {campaignId: campaign.id, sentAt: null}});

      const status = await CampaignService.completeCancelRevert(projectId, campaign.id);

      expect(status).toBe(CampaignStatus.DRAFT);
      const reverted = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
      // `startSending` stamps this before the first batch, so a revert has to clear it.
      expect(reverted.sentAt).toBeNull();
      expect(reverted.status).toBe(CampaignStatus.DRAFT);
    });

    it('keeps the campaign cancelled if an email departed while the cleanup ran', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await queueEmail(campaign.id);

      const {revertPending} = await CampaignService.cancel(projectId, campaign.id);
      expect(revertPending).toBe(true);

      // A worker already inside its SES call when the cancel landed, stamping its
      // email after the request had decided the campaign was revertible.
      await queueEmail(campaign.id, {status: EmailStatus.SENT, sentAt: new Date()});

      expect(await CampaignService.completeCancelRevert(projectId, campaign.id)).toBe(CampaignStatus.CANCELLED);
    });

    it('clears the live send progress so it cannot be folded into a later send', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await redis.set(Keys.Campaign.sentProgress(campaign.id), '7');

      // No rows, so this reverts inline.
      await CampaignService.cancel(projectId, campaign.id);

      expect(await redis.get(Keys.Campaign.sentProgress(campaign.id))).toBeNull();
    });

    it('re-queues the cleanup when cancel is re-run on a stuck campaign', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await queueEmail(campaign.id);
      await CampaignService.cancel(projectId, campaign.id);

      // The repair path: a cleanup that died leaves the campaign CANCELLED with rows
      // still to clear, and re-running cancel has to pick it back up rather than 400.
      const {campaign: result, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
      expect(revertPending).toBe(true);
    });
  });

  describe('when an email has already gone out', () => {
    it('stays permanently cancelled', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await queueEmail(campaign.id, {status: EmailStatus.SENT, sentAt: new Date()});
      await queueEmail(campaign.id);

      const {campaign: result, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
      expect(revertPending).toBe(false);
    });

    it('keeps the sent email rather than deleting the record of what was received', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      const sent = await queueEmail(campaign.id, {status: EmailStatus.SENT, sentAt: new Date()});
      await queueEmail(campaign.id);

      await CampaignService.cancel(projectId, campaign.id);

      expect(await prisma.email.findUnique({where: {id: sent.id}})).not.toBeNull();
      // The pending sibling is left alone too: a terminal campaign is not cleaned up.
      expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
    });

    it('treats an email mid-dispatch as gone', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      // SENDING means the worker is past its guard and inside the SES call. It has no
      // `sentAt` yet, but it cannot be called back.
      await queueEmail(campaign.id, {status: EmailStatus.SENDING});

      const {campaign: result, revertPending} = await CampaignService.cancel(projectId, campaign.id);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
      expect(revertPending).toBe(false);
    });

    it('treats a FAILED email that SES had already accepted as gone', async () => {
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      // The send path's catch marks an email FAILED without clearing `sentAt`, so an
      // email SES accepted before a later step threw is both FAILED and sent. Reading
      // status alone would delete the only record of a message someone received.
      await queueEmail(campaign.id, {status: EmailStatus.FAILED, sentAt: new Date()});

      const {campaign: result} = await CampaignService.cancel(projectId, campaign.id);

      expect(result.status).toBe(CampaignStatus.CANCELLED);
    });
  });

  it('rejects a campaign that is not scheduled or sending', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENT});

    await expect(CampaignService.cancel(projectId, campaign.id)).rejects.toThrow(
      'Can only cancel scheduled or sending campaigns',
    );
  });
});

/**
 * The cleanup's raw SQL, tested on its own. Its predicates are what stand between
 * clearing a queue and destroying delivery history, and neither is expressible in the
 * `deleteMany` the rest of the codebase would use -- Prisma has no LIMIT there, and an
 * unbounded delete is the thing this job exists to avoid.
 */
describe('deleteUnsentCampaignEmails', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let campaignId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
    campaignId = campaign.id;
  });

  async function makeEmail(overrides: {sentAt?: Date | null; createdAt?: Date} = {}) {
    const contact = await factories.createContact({projectId, email: `c-${Date.now()}-${Math.random()}@plunk.test`});
    return prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId,
        subject: 'Cleanup',
        body: '<p>x</p>',
        from: 'hello@plunk.test',
        sourceType: 'CAMPAIGN',
        status: overrides.sentAt ? EmailStatus.SENT : EmailStatus.PENDING,
        sentAt: overrides.sentAt ?? null,
        ...(overrides.createdAt ? {createdAt: overrides.createdAt} : {}),
      },
    });
  }

  it('deletes the unsent rows and reports how many', async () => {
    await makeEmail();
    await makeEmail();

    const deleted = await deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000));

    expect(deleted).toBe(2);
    expect(await prisma.email.count({where: {campaignId}})).toBe(0);
  });

  it('never deletes a row that has been stamped sent', async () => {
    const sent = await makeEmail({sentAt: new Date()});
    await makeEmail();

    const deleted = await deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000));

    expect(deleted).toBe(1);
    expect(await prisma.email.findUnique({where: {id: sent.id}})).not.toBeNull();
  });

  it('never deletes a row being sent, which SES may be accepting at that moment', async () => {
    const sending = await makeEmail();
    await prisma.email.update({where: {id: sending.id}, data: {status: EmailStatus.SENDING}});
    await makeEmail();

    const deleted = await deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000));

    // The row stays, so the revert sees an email that may have departed and keeps the campaign
    // cancelled instead of letting it be sent again
    expect(deleted).toBe(1);
    expect(await prisma.email.findUnique({where: {id: sending.id}})).not.toBeNull();
  });

  /**
   * Claim an email as a worker that read the campaign as sending before the cancel does, while the
   * cleanup runs: it picks the row while still PENDING and waits for the claim to commit. Returns
   * what the cleanup deleted.
   */
  async function cleanUpWhileClaiming(emailId: string): Promise<number> {
    let deleting: Promise<number> | undefined;
    await prisma.$transaction(async tx => {
      await tx.email.updateMany({
        where: {id: emailId, status: EmailStatus.PENDING},
        data: {status: EmailStatus.SENDING},
      });
      deleting = deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000));
      // Commit only once the delete is waiting on the claimed row: earlier, it would read the
      // row as SENDING and skip it with or without the re-check
      for (let waited = 0; ; waited += 20) {
        const [{blocked}] = await prisma.$queryRaw<{blocked: bigint}[]>`
          SELECT count(*) AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%DELETE FROM "emails"%'
        `;
        if (blocked > 0n) break;
        if (waited > 4000) throw new Error('The cleanup never waited on the claimed row');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    return deleting!;
  }

  it('never deletes a row a worker claims while the delete waits for it', async () => {
    const claimed = await makeEmail();

    expect(await cleanUpWhileClaiming(claimed.id)).toBe(0);
    expect((await prisma.email.findUnique({where: {id: claimed.id}}))?.status).toBe(EmailStatus.SENDING);
  });

  it('goes on past a batch that a claimed row cut short', async () => {
    const contact = await factories.createContact({projectId, email: `bulk-${Date.now()}@plunk.test`});
    await prisma.email.createMany({
      data: Array.from({length: 1100}, () => ({
        projectId,
        contactId: contact.id,
        campaignId,
        subject: 'Bulk',
        body: '<p>x</p>',
        from: 'hello@plunk.test',
        sourceType: EmailSourceType.CAMPAIGN,
        status: EmailStatus.PENDING,
      })),
    });
    // The first row the cleanup's first batch reads, so that batch deletes one row short of full
    const [first] = await prisma.$queryRaw<{id: string}[]>`
      SELECT "id" FROM "emails" WHERE "campaignId" = ${campaignId} AND "sentAt" IS NULL LIMIT 1
    `;

    expect(await cleanUpWhileClaiming(first.id)).toBe(1099);
    expect(await prisma.email.count({where: {campaignId}})).toBe(1);
  });

  it('leaves rows created after the cancellation alone', async () => {
    // The campaign went back to draft and was sent again while this cleanup was still
    // draining. Those rows belong to the new send and deleting them would gut it.
    const cutoff = new Date();
    await makeEmail({createdAt: new Date(cutoff.getTime() - 5000)});
    const fromLaterSend = await makeEmail({createdAt: new Date(cutoff.getTime() + 5000)});

    const deleted = await deleteUnsentCampaignEmails(campaignId, cutoff);

    expect(deleted).toBe(1);
    expect(await prisma.email.findUnique({where: {id: fromLaterSend.id}})).not.toBeNull();
  });

  it('leaves other campaigns untouched', async () => {
    const other = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const contact = await factories.createContact({projectId, email: `other-${Date.now()}@plunk.test`});
    const otherEmail = await prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId: other.id,
        subject: 'Other',
        body: '<p>x</p>',
        from: 'hello@plunk.test',
        sourceType: 'CAMPAIGN',
        status: EmailStatus.PENDING,
      },
    });
    await makeEmail();

    await deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000));

    expect(await prisma.email.findUnique({where: {id: otherEmail.id}})).not.toBeNull();
  });

  it('is a no-op when there is nothing to clear', async () => {
    expect(await deleteUnsentCampaignEmails(campaignId, new Date())).toBe(0);
  });

  it('loops until the campaign is drained, past a single batch', async () => {
    // The reason this job exists is volume, so the batching has to be exercised rather
    // than assumed: everything above fits in one statement and never takes the branch.
    const contact = await factories.createContact({projectId, email: `bulk-${Date.now()}@plunk.test`});
    const rows = Array.from({length: 1100}, () => ({
      projectId,
      contactId: contact.id,
      campaignId,
      subject: 'Bulk',
      body: '<p>x</p>',
      from: 'hello@plunk.test',
      sourceType: EmailSourceType.CAMPAIGN,
      status: EmailStatus.PENDING,
    }));
    await prisma.email.createMany({data: rows});

    const progress: number[] = [];
    const deleted = await deleteUnsentCampaignEmails(campaignId, new Date(Date.now() + 1000), async soFar => {
      progress.push(soFar);
    });

    expect(deleted).toBe(1100);
    expect(await prisma.email.count({where: {campaignId}})).toBe(0);
    // A full batch, the remainder, and then an empty batch ends the loop.
    expect(progress).toEqual([1000, 1100]);
  });
});
