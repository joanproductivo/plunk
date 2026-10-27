import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignStatus, EmailStatus, EmailSourceType} from '@plunk/db';
import {ReputationPolicy} from '../ReputationPolicy';
import {SecurityService} from '../SecurityService';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as appPrisma} from '../../database/prisma';
import {redis} from '../../database/redis';
import {sendRawEmail} from '../SESService';

const flags = vi.hoisted(() => ({autoProjectDisable: true}));

vi.mock('../../app/constants.js', async () => {
  const actual = await vi.importActual('../../app/constants.js');
  return {
    ...actual,
    // A getter, so a test can turn auto-disable off
    get AUTO_PROJECT_DISABLE() {
      return flags.autoProjectDisable;
    },
  };
});

// Mock NtfyService to prevent actual notifications
vi.mock('../NtfyService.js', () => ({
  NtfyService: {
    notifySecurityWarning: vi.fn(),
    notifyProjectDisabledForSecurity: vi.fn(),
  },
}));

// The alerts to the project's addresses (Plunk Lite) go out through SES
vi.mock('../SESService.js', async () => ({
  ...(await vi.importActual('../SESService.js')),
  sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'})),
}));

// Mock email sending for project disabled notifications
vi.mock('@plunk/email', () => ({
  ProjectDisabledEmail: vi.fn(),
  sendPlatformEmail: vi.fn(),
}));

describe('SecurityService', () => {
  let projectId: string;
  let contactId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;

    const contact = await factories.createContact({projectId});
    contactId = contact.id;

    // Clear redis cache
    await redis.flushdb();
    flags.autoProjectDisable = true;
  });

  /**
   * Helper to create N emails, some of which are bounced
   */
  async function createEmails(
    count: number,
    opts?: {bouncedCount?: number; complainedCount?: number; createdAt?: Date; simulated?: boolean},
  ) {
    const bouncedCount = opts?.bouncedCount ?? 0;
    const complainedCount = opts?.complainedCount ?? 0;
    const createdAt = opts?.createdAt ?? new Date();

    const data = Array.from({length: count}, (_, i) => ({
      projectId,
      contactId,
      subject: `Test ${i}`,
      body: '<p>test</p>',
      from: 'test@example.com',
      status: EmailStatus.SENT,
      sourceType: EmailSourceType.TRANSACTIONAL,
      sentAt: createdAt,
      createdAt,
      bouncedAt: i < bouncedCount ? createdAt : null,
      complainedAt: i >= bouncedCount && i < bouncedCount + complainedCount ? createdAt : null,
      simulated: opts?.simulated ?? false,
    }));
    await prisma.email.createMany({data});
  }

  describe('Rate-based checks (existing behavior)', () => {
    it('should report healthy when bounce rate is below warning', async () => {
      // 400 emails, 5 bounces = 1.25% (below the 2.5% warning)
      await createEmails(400, {bouncedCount: 5});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isHealthy).toBe(true);
      expect(status.shouldDisable).toBe(false);
      expect(status.violations).toHaveLength(0);
      expect(status.warnings).toHaveLength(0);
    });

    it('should trigger warning when 7-day bounce rate exceeds warning threshold', async () => {
      // 200 emails, 6 bounces = 3% (above the 2.5% warning, below the 5% critical)
      await createEmails(200, {bouncedCount: 6});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isHealthy).toBe(true);
      expect(status.warnings.length).toBeGreaterThan(0);
    });

    it('should trigger violation when 7-day bounce rate exceeds critical threshold', async () => {
      // 100 emails, 11 bounces = 11% (above the 5% critical)
      await createEmails(100, {bouncedCount: 11});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isHealthy).toBe(false);
      expect(status.shouldDisable).toBe(true);
      expect(status.violations.length).toBeGreaterThan(0);
    });

    it('counts only emails given to SES, so a queued campaign does not dilute the rate', async () => {
      // 100 sent, 11 bounced = 11% -- with 2,000 more still queued for a campaign, which used to
      // read as 0.5% while the send was going out
      await createEmails(100, {bouncedCount: 11});
      await prisma.email.createMany({
        data: Array.from({length: 2000}, (_, i) => ({
          projectId,
          contactId,
          subject: `Queued ${i}`,
          body: '<p>queued</p>',
          from: 'test@example.com',
          status: EmailStatus.PENDING,
          sourceType: EmailSourceType.CAMPAIGN,
        })),
      });

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.sevenDay.total).toBe(100);
      expect(status.shouldDisable).toBe(true);
    });

    it('should not enforce rate checks when below minimum volume', async () => {
      // 50 emails (below 100 minimum), 10 bounces = 20% (would exceed critical)
      await createEmails(50, {bouncedCount: 10});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.violations).toHaveLength(0);
    });
  });

  describe('Established projects skip absolute ceilings', () => {
    // Age the project past the new-project window
    beforeEach(async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({
        where: {id: projectId},
        data: {createdAt: oldDate},
      });
    });

    it('should NOT trigger on high absolute bounce count when rate is healthy', async () => {
      // 20,000 emails, 200 bounces = 1% rate (well below rate threshold)
      // Established projects rely solely on rates — high absolute counts at
      // high volume don't indicate abuse.
      await createEmails(20000, {bouncedCount: 200});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isHealthy).toBe(true);
      expect(status.shouldDisable).toBe(false);
      expect(status.violations).toHaveLength(0);
      expect(status.warnings).toHaveLength(0);
    });

    it('should NOT trigger on high absolute complaint count when rate is healthy', async () => {
      // 40,000 emails, 30 complaints = 0.075% (below critical: 0.1% 7-day, 0.08% all-time)
      // Old absolute ceiling (25 complaints in 7d critical) would have tripped.
      await createEmails(40000, {complainedCount: 30});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.shouldDisable).toBe(false);
    });
  });

  describe('New project stricter thresholds', () => {
    it('should apply stricter ceilings for projects under 30 days old', async () => {
      // Default project is created "now", so it's a new project
      // 10,000 emails, 26 bounces (above 25 new project 24h critical ceiling)
      await createEmails(10000, {bouncedCount: 26});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isNewProject).toBe(true);
      expect(status.shouldDisable).toBe(true);
      expect(status.violations.some(v => v.includes('new project'))).toBe(true);
    });

    it('should NOT apply absolute ceilings for projects over 30 days old', async () => {
      // Age the project to 31 days
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({
        where: {id: projectId},
        data: {createdAt: oldDate},
      });

      // 10,000 emails, 26 bounces — would trip new-project ceiling, but
      // established projects skip ceilings entirely (rate is 0.26%, healthy).
      await createEmails(10000, {bouncedCount: 26});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isNewProject).toBe(false);
      expect(status.warnings.some(w => w.includes('bounce count'))).toBe(false);
      expect(status.violations.some(v => v.includes('bounce count'))).toBe(false);
    });

    it('should catch new project blasting emails with delayed bounces', async () => {
      // Simulate the spammer scenario: new project sends 20K emails,
      // only 30 bounces have come back so far (rate is tiny: 0.15%)
      await createEmails(20000, {bouncedCount: 30});

      const status = await SecurityService.getSecurityStatus(projectId);
      expect(status.isNewProject).toBe(true);
      expect(status.shouldDisable).toBe(true);
      // 30 > 25 new project 24h critical ceiling
      expect(status.violations.some(v => v.includes('24-hour bounce count'))).toBe(true);
    });
  });

  describe('checkAndEnforceSecurityLimits', () => {
    it('should disable project when critical thresholds are exceeded', async () => {
      // Plunk Lite: 30 bounces in 300 emails (10%) is past disabling: 8%, with 25 bounces in 200
      await createEmails(300, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      const project = await prisma.project.findUnique({
        where: {id: projectId},
        select: {disabled: true},
      });
      expect(project?.disabled).toBe(true);
      // Plunk Lite: the dashboard's failure alerts show it
      expect(await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'project'}})).toMatchObject({
        label: 'Project disabled',
      });
      // The disabled project is the alert; no reputation alert besides it
      expect(await prisma.plunkLiteFailure.count({where: {projectId, sourceKey: 'security:critical'}})).toBe(0);
    });

    it('returns to the drafts on reactivation only the scheduled campaigns the disable cancelled', async () => {
      const scheduledFor = new Date(Date.now() + 86_400_000);
      const scheduled = await factories.createScheduledCampaign(projectId, scheduledFor, {
        status: CampaignStatus.SCHEDULED,
      });
      const byHand = await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
      await createEmails(300, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: scheduled.id}})).status).toBe(
        CampaignStatus.CANCELLED,
      );

      expect(await ReputationPolicy.reactivate(projectId, 'admin@example.com')).toEqual({draftedCampaigns: 1});
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: scheduled.id}})).status).toBe(CampaignStatus.DRAFT);
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: byHand.id}})).status).toBe(CampaignStatus.CANCELLED);
    });

    it('emails the alert addresses when it disables the project', async () => {
      await factories.createDomain({projectId, domain: 'example.com'});
      await prisma.plunkLiteAlertSettings.create({
        data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
      });
      await createEmails(300, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(sendRawEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['ops@example.org'],
          content: expect.objectContaining({subject: expect.stringMatching(/Needs attention: Project disabled$/)}),
        }),
      );
    });

    it('records a critical rate as a reputation alert when auto-disable is off', async () => {
      flags.autoProjectDisable = false;
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({where: {id: projectId}, data: {createdAt: oldDate}});
      // Critical 7-day bounce rate
      await createEmails(100, {bouncedCount: 11});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      const project = await prisma.project.findUnique({where: {id: projectId}, select: {disabled: true}});
      expect(project?.disabled).toBe(false);
      const failure = await prisma.plunkLiteFailure.findFirstOrThrow({
        where: {projectId, sourceKey: 'security:critical'},
      });
      expect(failure.label).toBe('Sending reputation: critical');
      expect(failure.lastError).toContain('7-day bounce rate');
    });

    it('should NOT disable project when only warnings exist', async () => {
      // Established project, 400 emails, 12 bounces = 3% (above the warnings, below the 4% and
      // 5% criticals)
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({
        where: {id: projectId},
        data: {createdAt: oldDate},
      });
      await createEmails(400, {bouncedCount: 12});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      const project = await prisma.project.findUnique({
        where: {id: projectId},
        select: {disabled: true},
      });
      expect(project?.disabled).toBe(false);
      // Plunk Lite: the dashboard's failure alerts show the warning
      expect(
        await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'security:warning'}}),
      ).toMatchObject({label: 'Sending reputation: warning'});
    });
  });

  /**
   * Enforcement runs on each new bounce or complaint, but only the metric that event moved
   * may disable. A project re-enabled with an old critical all-time complaint rate was
   * re-disabled by its next bounce, which cannot have raised the complaint rate.
   */
  describe('checkAndEnforceSecurityLimits gates on the triggering metric', () => {
    beforeEach(async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({where: {id: projectId}, data: {createdAt: oldDate}});
    });

    async function isDisabled() {
      const project = await prisma.project.findUnique({where: {id: projectId}, select: {disabled: true}});
      return project?.disabled;
    }

    it('does not disable on a bounce when only the complaint rate is past disabling', async () => {
      // 5 complaints in 1,000 emails: 0.5%, past 0.4%
      await createEmails(1000, {complainedCount: 5});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(false);
    });

    it('disables on a complaint when the complaint rate is past disabling', async () => {
      await createEmails(1000, {complainedCount: 5});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['complaint']);

      expect(await isDisabled()).toBe(true);
    });

    it('disables on a bounce when the bounce rate is past disabling', async () => {
      await createEmails(300, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(true);
    });

    it('does not disable on a complaint when only the bounce rate is past disabling', async () => {
      await createEmails(300, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['complaint']);

      expect(await isDisabled()).toBe(false);
    });

    it('keeps the reason of a project disabled for something else while the rates were read', async () => {
      await createEmails(300, {bouncedCount: 30});
      // Read as enabled, then disabled for its content before the disable is written
      const findUnique = appPrisma.project.findUnique.bind(appPrisma.project);
      vi.spyOn(appPrisma.project, 'findUnique').mockImplementation((async (args: {select?: {disabled?: boolean}}) => {
        const project = await findUnique(args as never);
        if (args.select?.disabled) {
          await prisma.project.update({
            where: {id: projectId},
            data: {disabled: true, disabledReason: 'PHISHING_DETECTED'},
          });
          return {...project, disabled: false};
        }
        return project;
      }) as never);

      try {
        await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);
      } finally {
        vi.restoreAllMocks();
      }

      expect(await prisma.project.findUniqueOrThrow({where: {id: projectId}})).toMatchObject({
        disabled: true,
        disabledReason: 'PHISHING_DETECTED',
      });
      expect(await prisma.plunkLiteFailure.count({where: {projectId, sourceKey: 'project'}})).toBe(0);
    });

    it('disables on a burst that moved both, for either of them', async () => {
      await createEmails(1000, {complainedCount: 5});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce', 'complaint']);

      expect(await isDisabled()).toBe(true);
    });
  });

  /**
   * Plunk Lite: a project is only disabled as a last resort, past 8% bounces or 0.4% complaints in 7
   * days. Plunk's other criticals -- the 7-day ones short of that, the all-time rates, the ceilings
   * for new projects -- alert, and stop the campaign or workflow sending (SourceBrakeService).
   */
  describe('disabling as a last resort', () => {
    async function isDisabled() {
      return (await prisma.project.findUniqueOrThrow({where: {id: projectId}})).disabled;
    }

    async function criticalAlert() {
      return prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'security:critical'}});
    }

    beforeEach(async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await prisma.project.update({where: {id: projectId}, data: {createdAt: oldDate}});
    });

    it('only alerts at a 7% bounce rate', async () => {
      await createEmails(400, {bouncedCount: 28});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(false);
      expect((await criticalAlert())?.lastError).toContain('7-day bounce rate');
    });

    it('disables at 9% with 30 bounces, saying why', async () => {
      await createEmails(334, {bouncedCount: 30});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(true);
      const alert = await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId, sourceKey: 'project'}});
      expect(alert.lastError).toMatch(/^7-day bounce rate \(8\.98%, 30 of 334 emails\) reached 8%$/);
    });

    it('does not disable at 9% with fewer than 25 bounces', async () => {
      await createEmails(220, {bouncedCount: 20});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(false);
    });

    it('disables on 5 complaints however few emails went out', async () => {
      // 5 complaints in 150 emails: no minimum of emails, as there is for bounces
      await createEmails(150, {complainedCount: 5});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['complaint']);

      expect(await isDisabled()).toBe(true);
    });

    it('does not disable on 4 complaints, however high the rate', async () => {
      await createEmails(50, {complainedCount: 4});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['complaint']);

      expect(await isDisabled()).toBe(false);
    });

    it('only alerts on an all-time rate, however high', async () => {
      const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      await createEmails(1000, {bouncedCount: 50, complainedCount: 6, createdAt: longAgo});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce', 'complaint']);

      expect(await isDisabled()).toBe(false);
      expect((await criticalAlert())?.lastError).toContain('All-time bounce rate');
    });

    it('only alerts on the 24-hour and 7-day ceilings of a new project', async () => {
      await prisma.project.update({where: {id: projectId}, data: {createdAt: new Date()}});
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      // 25 bounces today and 60 in the week, out of 30,000: past all the bounce ceilings, 0.3%
      await createEmails(20000, {bouncedCount: 25});
      await createEmails(10000, {bouncedCount: 35, createdAt: threeDaysAgo});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['bounce']);

      expect(await isDisabled()).toBe(false);
      const {lastError} = (await criticalAlert())!;
      expect(lastError).toContain('24-hour bounce count (new project)');
      expect(lastError).toContain('7-day bounce count (new project)');
    });

    it('only alerts on the complaint ceilings of a new project', async () => {
      await prisma.project.update({where: {id: projectId}, data: {createdAt: new Date()}});
      // 25 complaints in 20,000: past both complaint ceilings, 0.125%, short of 0.4%
      await createEmails(20000, {complainedCount: 25});

      await SecurityService.checkAndEnforceSecurityLimits(projectId, ['complaint']);

      expect(await isDisabled()).toBe(false);
      expect((await criticalAlert())?.lastError).toContain('7-day complaint count (new project)');
    });
  });

  describe('getProjectSecurityMetrics (client-facing)', () => {
    it('should NOT expose internal thresholds or detailed violation messages', async () => {
      // Create a violation scenario
      await createEmails(100, {bouncedCount: 15});

      const metrics = await SecurityService.getProjectSecurityMetrics(projectId);

      // Should have levels, not thresholds
      expect(metrics.levels).toBeDefined();
      expect((metrics as Record<string, unknown>).thresholds).toBeUndefined();

      // Violation messages should be generic
      if (metrics.status.violations.length > 0) {
        for (const v of metrics.status.violations) {
          expect(v).toBe('Security threshold exceeded');
          expect(v).not.toMatch(/\d+%/); // No percentages
          expect(v).not.toMatch(/\d+ minimum/); // No absolute numbers
        }
      }

      // 24-hour data should be zeroed out
      expect(metrics.status.twentyFourHour.total).toBe(0);
      expect(metrics.status.twentyFourHour.bounces).toBe(0);

      // New project flag should be hidden
      expect(metrics.status.isNewProject).toBe(false);

      // Internal enforcement flags should not leak
      expect(metrics.status).not.toHaveProperty('criticalByMetric');
    });
  });
  describe('SES mailbox simulator', () => {
    /**
     * Mail to `@simulator.amazonses.com` never leaves AWS, and AWS excludes it from its own
     * bounce and complaint rates. Plunk counted it, so rehearsing bounce handling against
     * the simulator -- the thing AWS documents it for -- could warn or disable the project
     * doing the rehearsing.
     */
    it('should exclude simulated bounces from the rates entirely', async () => {
      await createEmails(100);
      // 50 bounces out of 150 is 33%, far past the 5% critical threshold.
      await createEmails(50, {bouncedCount: 50, simulated: true});

      const status = await SecurityService.getSecurityStatus(projectId);

      expect(status.sevenDay.bounces).toBe(0);
      expect(status.sevenDay.bounceRate).toBe(0);
      expect(status.isHealthy).toBe(true);
      expect(status.shouldDisable).toBe(false);
      expect(status.violations).toHaveLength(0);
      expect(status.warnings).toHaveLength(0);
    });

    it('should exclude simulated complaints from the rates entirely', async () => {
      await createEmails(100);
      await createEmails(50, {complainedCount: 50, simulated: true});

      const status = await SecurityService.getSecurityStatus(projectId);

      expect(status.sevenDay.complaints).toBe(0);
      expect(status.sevenDay.complaintRate).toBe(0);
      expect(status.isHealthy).toBe(true);
      expect(status.shouldDisable).toBe(false);
    });

    it('should leave simulated emails out of the denominator too', async () => {
      // Dropping only the numerator would leave the test sends padding the denominator and
      // understating the real bounce rate: 6 bounces in 100 real emails is a warning, but
      // 6 in 600 reads as 1% and passes.
      await createEmails(100, {bouncedCount: 6});
      await createEmails(500, {simulated: true});

      const status = await SecurityService.getSecurityStatus(projectId);

      expect(status.sevenDay.total).toBe(100);
      expect(status.sevenDay.bounceRate).toBeCloseTo(6, 5);
      expect(status.warnings.length).toBeGreaterThan(0);
    });

    it('should still count real bounces alongside simulated ones', async () => {
      await createEmails(100, {bouncedCount: 11});
      await createEmails(50, {bouncedCount: 50, simulated: true});

      const status = await SecurityService.getSecurityStatus(projectId);

      expect(status.sevenDay.total).toBe(100);
      expect(status.sevenDay.bounces).toBe(11);
      expect(status.shouldDisable).toBe(true);
    });
  });
});
