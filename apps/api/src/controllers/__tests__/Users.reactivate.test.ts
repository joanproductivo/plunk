import {randomUUID} from 'node:crypto';

import type {Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {CampaignStatus, EmailSourceType, EmailStatus, Role} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {redis} from '../../database/redis';
import {HttpException} from '../../exceptions/index';
import {ContactService} from '../../services/ContactService';
import {Keys} from '../../services/keys';
import {ProjectService} from '../../services/ProjectService';
import {ReputationPolicy} from '../../services/ReputationPolicy';
import {Users} from '../Users';

/** Calls the handler as Express would, as in Alerts.test.ts */
async function reactivate(userId: string, projectId: string) {
  let status = 200;
  let json: unknown;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth: {type: 'jwt', userId}},
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        json = value;
        resolve();
        return this;
      },
    } as unknown as Response;
    void new Users().reactivateProject({params: {id: projectId}} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, json, error};
}

/**
 * Plunk Lite: an owner or admin reactivates a project disabled for its sending reputation from the
 * dashboard, instead of with SQL.
 */
describe('POST /users/@me/projects/:id/reactivate', () => {
  const prisma = getPrismaClient();
  let userId: string;
  let userEmail: string;
  let projectId: string;
  const graceKey = () => `plunk-lite:reactivated:${projectId}`;

  beforeEach(async () => {
    await redis.flushdb();
    const {user, project} = await factories.createUserWithProject();
    userId = user.id;
    userEmail = user.email;
    projectId = project.id;
    await prisma.project.update({where: {id: projectId}, data: {disabled: true, disabledReason: 'EMAIL_REPUTATION'}});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function project() {
    return prisma.project.findUniqueOrThrow({where: {id: projectId}});
  }

  it('reactivates it, drops it from the caches and returns the cancelled scheduled campaigns to the drafts', async () => {
    const contact = await factories.createContact({projectId});
    const scheduled = await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
    const halfSent = await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
    await prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        campaignId: halfSent.id,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hi@example.com',
        sourceType: EmailSourceType.CAMPAIGN,
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId: randomUUID(),
      },
    });
    const cached = await ProjectService.id(projectId);
    await ProjectService.secret(cached!.secret);
    await prisma.plunkLiteFailure.create({
      data: {projectId, sourceKey: 'project', label: 'Project disabled', lastError: '7-day bounce rate'},
    });

    const {status, json} = await reactivate(userId, projectId);

    expect(status).toBe(200);
    expect(json).toEqual({draftedCampaigns: 1});
    expect(await project()).toMatchObject({disabled: false, disabledReason: null});
    expect(await redis.exists(Keys.Project.id(projectId), Keys.Project.secret(cached!.secret))).toBe(0);
    expect(await redis.ttl(graceKey())).toBeGreaterThan(7 * 86400 - 60);
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: scheduled.id}})).status).toBe(CampaignStatus.DRAFT);
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: halfSent.id}})).status).toBe(CampaignStatus.CANCELLED);

    const failures = await prisma.plunkLiteFailure.findMany({where: {projectId}});
    const disabled = failures.find(failure => failure.sourceKey === 'project')!;
    expect(disabled.reviewedAt).toEqual(disabled.lastAt);
    expect(failures.find(failure => failure.sourceKey === 'project:reactivated')?.lastError).toContain(
      `Reactivated by ${userEmail}. For 7 days only the emails sent from now on count`,
    );
  });

  it('is only for owners and admins', async () => {
    const member = await factories.createUser();
    await prisma.membership.create({data: {userId: member.id, projectId, role: Role.MEMBER}});

    const {error} = await reactivate(member.id, projectId);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).code).toBe(403);
    expect((await project()).disabled).toBe(true);
  });

  it.each([
    ['disabled for another reason', {disabled: true, disabledReason: 'PHISHING_DETECTED' as const}],
    ['not disabled', {disabled: false, disabledReason: null}],
  ])('answers 409 for a project %s, and leaves it as it is', async (_case, data) => {
    await prisma.project.update({where: {id: projectId}, data});

    const {error} = await reactivate(userId, projectId);

    expect((error as HttpException).code).toBe(409);
    expect(await project()).toMatchObject(data);
    expect(await redis.exists(graceKey())).toBe(0);
  });

  it('leaves the project disabled when its grace period cannot be stored', async () => {
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('Redis down'));

    const {error} = await reactivate(userId, projectId);

    expect((error as Error).message).toBe('Redis down');
    expect((await project()).disabled).toBe(true);
  });

  describe('the grace period', () => {
    /** 300 emails sent, 30 of them bounced (10%, past disabling), created at `createdAt` */
    async function bounced(createdAt: Date, {total = 300, bounces = 30} = {}) {
      const contact = await factories.createContact({projectId});
      await prisma.email.createMany({
        data: Array.from({length: total}, (_, i) => ({
          projectId,
          contactId: contact.id,
          subject: 'Hi',
          body: '<p>Hi</p>',
          from: 'hi@example.com',
          sourceType: EmailSourceType.TRANSACTIONAL,
          status: EmailStatus.SENT,
          sentAt: createdAt,
          createdAt,
          bouncedAt: i < bounces ? createdAt : null,
        })),
      });
      return contact;
    }

    it('keeps the bounces from before the reactivation from disabling the project again', async () => {
      await bounced(new Date(Date.now() - 86_400_000));
      await reactivate(userId, projectId);

      expect((await ReputationPolicy.disableByMetric(projectId)).bounce).toBe(false);

      await bounced(new Date(Date.now() + 1000));
      const verdict = await ReputationPolicy.disableByMetric(projectId);
      expect(verdict.bounce).toBe(true);
      expect(verdict.violations[0]).toMatch(/^Since reactivation, bounce rate \(10\.00%, 30 of 300 emails\)/);
    });

    it('does not count again the bounces deleted in the hour of the reactivation, before it', async () => {
      // Disabled for them, their contacts deleted, then reactivated, all in the same hour: the
      // deleted emails are counted by that hour
      const contact = await bounced(new Date());
      await ContactService.bulkDelete(projectId, [contact.id]);
      await reactivate(userId, projectId);

      await bounced(new Date(Date.now() + 1000), {total: 10, bounces: 1});

      expect((await ReputationPolicy.disableByMetric(projectId)).bounce).toBe(false);
      // The 7 days still count them
      await redis.del(graceKey());
      expect((await ReputationPolicy.disableByMetric(projectId)).sevenDay).toMatchObject({total: 310, bounces: 31});
    });

    it('counts the bounces of emails sent after the reactivation, even when their contacts are deleted in its hour', async () => {
      await reactivate(userId, projectId);
      const contact = await bounced(new Date(Date.now() + 1000));
      await ContactService.bulkDelete(projectId, [contact.id]);

      const verdict = await ReputationPolicy.disableByMetric(projectId);
      expect(verdict.sevenDay).toMatchObject({total: 300, bounces: 30});
      expect(verdict.bounce).toBe(true);
    });

    it('counts the whole hour of the reactivation when the grace period does not say what it held', async () => {
      const contact = await bounced(new Date());
      await ContactService.bulkDelete(projectId, [contact.id]);
      await reactivate(userId, projectId);
      // As the grace period was first stored: the date alone
      await redis.set(graceKey(), new Date(Date.now() - 1000).toISOString(), 'EX', 3600);

      expect((await ReputationPolicy.disableByMetric(projectId)).bounce).toBe(true);
    });

    it('counts the whole 7 days again once it is lost', async () => {
      await bounced(new Date(Date.now() - 86_400_000));
      await reactivate(userId, projectId);
      await redis.del(graceKey());

      expect((await ReputationPolicy.disableByMetric(projectId)).bounce).toBe(true);
    });
  });
});
