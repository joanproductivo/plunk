import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as servicePrisma} from '../../database/prisma';
import {redis} from '../../database/redis';
import {FailureAlertService} from '../FailureAlertService';
import {SecurityService} from '../SecurityService';
import {sendRawEmail} from '../SESService';

vi.mock('../SESService', () => ({
  sendRawEmail: vi.fn(async () => ({messageId: 'mock-message-id'})),
}));

const WORKFLOW = 'workflow:11111111-1111-4111-8111-111111111111';

/**
 * Plunk Lite's failure alerts: failures recorded per source, the open ones the banner shows, and
 * the email to the project's alert addresses at most once an hour per source.
 */
describe('FailureAlertService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
    await prisma.plunkLiteAlertSettings.create({
      data: {projectId, recipients: ['ops@example.org', 'boss@example.org'], fromEmail: 'alerts@example.com'},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const fail = (error = 'SES rejected it', sourceKey = WORKFLOW) =>
    FailureAlertService.record(projectId, {sourceKey, label: 'Welcome', error, contactEmail: 'ana@example.net'});

  /** The alert runs after `record` returns; give it time to reach SES */
  const settle = () => new Promise(resolve => setTimeout(resolve, 100));

  /**
   * The emails sent to this test's project, in order. Only its own: an alert recorded by an earlier
   * test, in another project, can still be on its way to SES.
   */
  const alerts = () =>
    vi
      .mocked(sendRawEmail)
      .mock.calls.map(([params]) => params)
      .filter(params => params.tags?.projectId === projectId);

  /** SES rejects the first email to this test's project, whatever else is on its way */
  const rejectFirst = (message: string) => {
    let rejected = false;
    vi.mocked(sendRawEmail).mockImplementation(async params => {
      if (!rejected && params.tags?.projectId === projectId) {
        rejected = true;
        throw new Error(message);
      }
      return {messageId: 'mock-message-id'};
    });
  };

  const row = () => prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId, sourceKey: WORKFLOW}});

  describe('recording', () => {
    it('counts failures under their source, keeping the last error', async () => {
      await fail('first');
      await fail('second');
      await fail('other source', 'transactional');

      expect(await row()).toMatchObject({count: 2, label: 'Welcome', lastError: 'second'});
      const open = await FailureAlertService.listOpen(projectId);
      expect(open.map(failure => failure.sourceKey).sort()).toEqual([WORKFLOW, 'transactional'].sort());
      expect(open.find(failure => failure.sourceKey === WORKFLOW)?.reviewPath).toBe(
        '/workflows/11111111-1111-4111-8111-111111111111?tab=executions',
      );
    });

    it('closes what was reviewed, and keeps open a source that failed after it was seen', async () => {
      await fail();
      const [seen] = await FailureAlertService.listOpen(projectId);
      await new Promise(resolve => setTimeout(resolve, 5));
      await fail();

      expect(await FailureAlertService.review(projectId, [{id: seen!.id, lastAt: seen!.lastAt}])).toBe(0);
      expect(await FailureAlertService.listOpen(projectId)).toHaveLength(1);

      const [latest] = await FailureAlertService.listOpen(projectId);
      expect(await FailureAlertService.review(projectId, [{id: latest!.id, lastAt: latest!.lastAt}])).toBe(1);
      expect(await FailureAlertService.listOpen(projectId)).toEqual([]);
    });

    it('opens a reviewed source again from a count of one, and alerts again', async () => {
      await fail();
      await fail();
      await settle();
      const [seen] = await FailureAlertService.listOpen(projectId);
      await FailureAlertService.review(projectId, [{id: seen!.id, lastAt: seen!.lastAt}]);
      vi.mocked(sendRawEmail).mockClear();

      const {firstAt: before} = await row();
      await fail('again');
      await settle();

      const reopened = await row();
      expect(reopened).toMatchObject({count: 1, lastError: 'again'});
      expect(reopened.firstAt.getTime()).toBeGreaterThan(before.getTime());
      expect(alerts()).toHaveLength(2); // one per address
    });

    it("does not review another project's failures", async () => {
      await fail();
      const [seen] = await FailureAlertService.listOpen(projectId);
      const {project: other} = await factories.createUserWithProject();

      expect(await FailureAlertService.review(other.id, [{id: seen!.id, lastAt: seen!.lastAt}])).toBe(0);
      expect(await FailureAlertService.listOpen(projectId)).toHaveLength(1);
    });

    it('never throws, whatever goes wrong, and says no alert is on its way', async () => {
      vi.spyOn(servicePrisma, '$queryRaw').mockRejectedValueOnce(new Error('database down'));
      await expect(fail()).resolves.toBe(false);
    });
  });

  describe('alerting', () => {
    it('emails each address once for failures arriving together, then not again within the hour', async () => {
      await Promise.all([fail(), fail(), fail()]);
      await settle();

      expect(alerts()).toHaveLength(2);
      const recipients = alerts().map(params => params.to);
      expect(recipients).toEqual(expect.arrayContaining([['ops@example.org'], ['boss@example.org']]));

      await fail();
      await settle();
      expect(alerts()).toHaveLength(2);
    });

    it('alerts again once the hour has passed, with the count so far', async () => {
      await fail();
      await fail();
      await settle();
      await prisma.plunkLiteFailure.updateMany({
        where: {projectId},
        data: {notifiedAt: new Date(Date.now() - 61 * 60 * 1000)},
      });
      vi.mocked(sendRawEmail).mockClear();

      await fail();
      await settle();

      expect(alerts()).toHaveLength(2);
      expect(alerts()[0]!.content.html).toContain('Failed 3 times');
    });

    it('keeps emailing the other addresses when one is rejected', async () => {
      rejectFirst('Email address is not verified.');

      await fail();
      await settle();

      expect(alerts()).toHaveLength(2);
    });

    it('says what failed in the subject', async () => {
      await fail();
      await fail('x', 'transactional');
      await settle();

      const subjects = alerts().map(params => params.content.subject);
      expect(subjects).toContain(
        '[' + (await prisma.project.findUniqueOrThrow({where: {id: projectId}})).name + '] Failed: Workflow "Welcome"',
      );
      expect(subjects.some(subject => subject.endsWith('Failed: Transactional emails'))).toBe(true);
    });

    it('gives the alert back when there was no one to tell, so the next failure alerts', async () => {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      await fail();
      await settle();
      expect((await row()).notifiedAt).toBeNull();

      await prisma.plunkLiteAlertSettings.create({
        data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
      });
      await fail();
      await settle();
      expect(alerts()).toHaveLength(1);
    });

    it('sends at most ten alerts an hour per project, however many sources fail', async () => {
      await prisma.plunkLiteAlertSettings.update({where: {projectId}, data: {recipients: ['ops@example.org']}});
      for (let n = 0; n < 12; n++) {
        await fail('x', `workflow:00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`);
      }
      await settle();

      expect(alerts()).toHaveLength(10);
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(12);
    });

    it('sends an automatic email with what the user wrote escaped, in the project language', async () => {
      await prisma.project.update({where: {id: projectId}, data: {language: 'es'}});
      await FailureAlertService.record(projectId, {
        sourceKey: WORKFLOW,
        label: '<b>Welcome</b>',
        error: '<script>alert(1)</script>',
      });
      await settle();

      const params = alerts()[0]!;
      expect(params.content.subject).toContain('Ha fallado: Workflow «<b>Welcome</b>»');
      expect(params.content.html).not.toContain('<script>');
      expect(params.content.html).toContain('&lt;script&gt;');
      expect(params.content.html).toContain('Ha fallado 1 vez');
      expect(params.headers).toMatchObject({'Auto-Submitted': 'auto-generated'});
      expect(params.tracking).toBe(false);
      expect(params.tags).toEqual({projectId, kind: 'alert'});
    });

    it('records but sends nothing without addresses, for a disabled project, or with no verified domain', async () => {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      await fail();
      await settle();
      expect(alerts()).toEqual([]);

      await prisma.plunkLiteAlertSettings.create({
        data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
      });
      await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
      await fail('x', 'transactional');
      await fail('x', 'campaign:22222222-2222-4222-8222-222222222222');
      await settle();
      expect(alerts()).toEqual([]);

      await prisma.project.update({where: {id: projectId}, data: {disabled: false}});
      await prisma.domain.updateMany({where: {projectId}, data: {verified: false}});
      await fail('x', 'project');
      await settle();
      expect(alerts()).toEqual([]);
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(4);
    });

    it('tells a disabled project about its suspension and its reputation, from its own SES account', async () => {
      await prisma.project.update({where: {id: projectId}, data: {disabled: true, language: 'es'}});

      await fail('7-day bounce rate too high', 'project');
      await fail('7-day bounce rate', 'security:critical');
      await fail('No events', 'sns:events');
      await settle();

      const subjects = alerts().map(params => params.content.subject);
      expect(subjects.filter(subject => subject.endsWith('Requiere atención: Proyecto desactivado'))).toHaveLength(2);
      expect(subjects.filter(subject => subject.includes('Reputación de envío: crítico'))).toHaveLength(2);
      expect(subjects).toHaveLength(6);
      const params = alerts()[0]!;
      expect(params.content.html).toContain('El proyecto no envía nada hasta que se reactive');
      expect(params.content.html).toContain('/settings?tab=security');
    });

    it('sends no test alert from a disabled project', async () => {
      await prisma.project.update({where: {id: projectId}, data: {disabled: true}});

      await expect(FailureAlertService.sendTest(projectId)).rejects.toThrow('A disabled project cannot send alerts');
      expect(alerts()).toEqual([]);
    });
  });

  describe('sender', () => {
    it("sends from the same name on another verified domain while the sender's is not verified", async () => {
      const other = await factories.createDomain({projectId, domain: 'other.example.com'});
      // Created later, so not the one chosen
      await factories.createDomain({projectId, domain: 'third.example.com'});
      await prisma.domain.updateMany({where: {projectId, domain: 'example.com'}, data: {verified: false}});

      await fail();
      await settle();

      expect(alerts().map(params => params.from.email)).toEqual([`alerts@${other.domain}`, `alerts@${other.domain}`]);
    });

    it("does not take another project's domain of the same name for the sender's", async () => {
      // The other project's comes first, as a lookup by name alone would find it
      await prisma.domain.deleteMany({where: {projectId}});
      const {project: otherProject} = await factories.createUserWithProject();
      await factories.createDomain({projectId: otherProject.id, domain: 'example.com'});
      await factories.createDomain({projectId, domain: 'example.com'});

      await fail();
      await settle();

      expect(alerts()[0]!.from.email).toBe('alerts@example.com');
    });
  });

  describe('conditions', () => {
    const warning = (bounces: number) =>
      `7-day bounce rate (${(bounces / 2).toFixed(2)}%, ${bounces} bounces) exceeds warning threshold (2.5%, 5 minimum)`;
    const complaint = 'All-time complaint rate (0.050%, 4 complaints) exceeds warning threshold (0.03%, 2 minimum)';
    const reputation = () => prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'security:warning'}});

    it('alerts on the sending reputation as needing attention, not as a failure', async () => {
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12)]);
      await settle();

      const [open] = await FailureAlertService.listOpen(projectId);
      expect(open).toMatchObject({label: 'Sending reputation: warning', reviewPath: '/settings?tab=security'});
      const params = alerts()[0]!;
      expect(params.content.subject).toMatch(/\] Needs attention: Sending reputation: warning$/);
      expect(params.content.html).toContain('Seen 1 time');
      expect(params.content.html).toContain('Details: 7-day bounce rate');
    });

    it('records conditions alerted on again only after a day, and a new condition at once', async () => {
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12)]);
      // The rate moved, but past the same threshold
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(14)]);
      expect(await reputation()).toMatchObject({count: 1});

      // An hour later, a new condition
      await prisma.plunkLiteFailure.updateMany({
        where: {projectId},
        data: {notifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)},
      });
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(14), complaint]);
      expect(await reputation()).toMatchObject({count: 2});
      // One of them went away: no news either
      await FailureAlertService.recordReputation(projectId, 'warning', [complaint]);
      expect(await reputation()).toMatchObject({count: 2});
      await settle();
      expect(alerts()).toHaveLength(4);

      // A day later, the same conditions are recorded again
      await redis.del(`plunk-lite:alerts:reputation:${projectId}:warning`);
      await FailureAlertService.recordReputation(projectId, 'warning', [complaint]);
      expect(await reputation()).toMatchObject({count: 3});
    });

    it('keeps recording a new condition that came up within the hour, until its alert goes out', async () => {
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12)]);
      // Within the hour of that alert: recorded, but not sent yet
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12), complaint]);
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12), complaint]);
      expect(await reputation()).toMatchObject({count: 3});
      await settle();
      expect(alerts()).toHaveLength(2);

      // Past the hour, the next event sends it
      await prisma.plunkLiteFailure.updateMany({
        where: {projectId},
        data: {notifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)},
      });
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(13), complaint]);
      await settle();
      expect(alerts()).toHaveLength(4);
      expect(alerts()[3]!.content.html).toContain('All-time complaint rate');
      // And from then on, those conditions are no news
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(13), complaint]);
      expect(await reputation()).toMatchObject({count: 4});
    });

    it('keeps warnings and critical rates apart, in the project language', async () => {
      await prisma.project.update({where: {id: projectId}, data: {language: 'es'}});
      await FailureAlertService.recordReputation(projectId, 'warning', [warning(12)]);
      await FailureAlertService.recordReputation(projectId, 'critical', [warning(30)]);
      await settle();

      expect((await FailureAlertService.listOpen(projectId)).map(failure => failure.sourceKey).sort()).toEqual([
        'security:critical',
        'security:warning',
      ]);
      const subjects = alerts().map(params => params.content.subject);
      expect(subjects.some(subject => subject.endsWith('Requiere atención: Reputación de envío: crítico'))).toBe(true);
      expect(subjects.some(subject => subject.endsWith('Requiere atención: Reputación de envío: aviso'))).toBe(true);
    });

    it('alerts on a domain that stopped being verified, with a link to the domains', async () => {
      const domain = await factories.createDomain({projectId, domain: 'news.example.com', verified: false});
      await FailureAlertService.recordDomainUnverified(projectId, domain, 'Failed');
      await settle();

      const [open] = await FailureAlertService.listOpen(projectId);
      expect(open).toMatchObject({
        sourceKey: `domain:${domain.id}`,
        label: 'news.example.com',
        reviewPath: '/settings?tab=domains',
      });
      expect(open!.lastError).toContain('SES reports the domain as Failed');
      expect(alerts()[0]!.content.subject).toMatch(/\] Needs attention: Domain "news\.example\.com"$/);
    });
  });

  describe('the SES event pipeline', () => {
    it('alerts on it as needing attention, with a link to the security settings, in the project language', async () => {
      await prisma.project.update({where: {id: projectId}, data: {language: 'es'}});
      await FailureAlertService.record(projectId, {
        sourceKey: 'sns:unmatched',
        label: 'SES events without an email',
        error: 'A bounce matched no email',
      });
      await settle();

      const [open] = await FailureAlertService.listOpen(projectId);
      expect(open).toMatchObject({sourceKey: 'sns:unmatched', reviewPath: '/settings?tab=security'});
      const params = alerts()[0]!;
      expect(params.content.subject).toMatch(/\] Requiere atención: Eventos de SES sin email$/);
      expect(params.content.html).toContain('Detectado 1 vez');
      expect(params.content.html).toContain('/settings?tab=security');
    });

    it('records it in every project that is not disabled', async () => {
      const {project: other} = await factories.createUserWithProject();
      const {project: disabled} = await factories.createUserWithProject({}, {disabled: true});

      await FailureAlertService.recordForAll({
        sourceKey: 'sns:subscription',
        label: 'SES events subscription removed',
        error: 'Unsubscribed',
      });

      const recorded = await prisma.plunkLiteFailure.findMany({
        where: {sourceKey: 'sns:subscription', projectId: {in: [projectId, other.id, disabled.id]}},
      });
      expect(recorded.map(failure => failure.projectId).sort()).toEqual([projectId, other.id].sort());
      // Its alerts go out after `recordForAll` returns: they must not reach the next test
      await settle();
    });
  });

  describe('Plunk Lite conditions', () => {
    const CAMPAIGN = '33333333-3333-4333-8333-333333333333';

    it.each([
      [`brake:campaign:${CAMPAIGN}`, 'Promo', 'Campaña «Promo» detenida', `/campaigns/${CAMPAIGN}`],
      ['brake:workflow:w1', 'Welcome', 'Workflow «Welcome» desactivado', '/workflows/w1'],
      ['project:reactivated', 'Project reactivated', 'Proyecto reactivado', '/settings?tab=security'],
      [
        'security:check',
        'Sending reputation check',
        'Comprobación de la reputación de envío',
        '/settings?tab=security',
      ],
      ['sns:events', 'SES events not arriving', 'Los eventos de SES no llegan', '/settings?tab=security'],
      ['sns:config', 'SES configuration sets', 'Configuration sets de SES', '/settings?tab=security'],
      ['ses:paused', 'SES', 'Amazon SES', '/activity'],
      ['ses:daily-quota', 'SES', 'Amazon SES', '/activity'],
    ])('names %s and links to where it is reviewed, as needing attention', async (sourceKey, label, name, path) => {
      await prisma.project.update({where: {id: projectId}, data: {language: 'es'}});
      await FailureAlertService.record(projectId, {sourceKey, label, error: 'Details'});
      await settle();

      const [open] = await FailureAlertService.listOpen(projectId);
      expect(open).toMatchObject({sourceKey, reviewPath: path});
      const params = alerts()[0]!;
      expect(params.content.subject).toMatch(new RegExp(`\\] Requiere atención: ${name}$`));
    });
  });

  describe('sources', () => {
    it('records a project disabled for its content, and emails the alert addresses about it', async () => {
      await SecurityService.disableProjectForPhishing(projectId, 'Subject', 99);
      await settle();

      expect(await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'project'}})).toMatchObject({
        label: 'Project disabled',
      });
      expect(alerts()).toHaveLength(2);
      expect(alerts()[0]!.content.subject).toMatch(/Needs attention: Project disabled$/);
    });

    it('records a campaign batch that ran out of attempts under the campaign', async () => {
      const campaign = await factories.createCampaign({projectId, name: 'October news'});

      await FailureAlertService.recordCampaignJob(campaign.id, 'Batch failed');

      expect(
        await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: `campaign:${campaign.id}`}}),
      ).toMatchObject({label: 'October news', lastError: 'Batch failed'});
    });
  });

  describe('settings', () => {
    it('keeps each address once, and turns the emails off with none', async () => {
      expect(
        await FailureAlertService.saveSettings(projectId, {
          recipients: ['ops@example.org', 'ops@example.org'],
          fromEmail: 'alerts@example.com',
        }),
      ).toEqual({recipients: ['ops@example.org'], fromEmail: 'alerts@example.com', fromName: null});

      expect(await FailureAlertService.saveSettings(projectId, {recipients: []})).toBeNull();
      expect(await FailureAlertService.getSettings(projectId)).toBeNull();
    });

    it('needs a sender on a verified domain of the project', async () => {
      await expect(
        FailureAlertService.saveSettings(projectId, {recipients: ['ops@example.org']}),
      ).rejects.toMatchObject({code: 400});
      await expect(
        FailureAlertService.saveSettings(projectId, {recipients: ['ops@example.org'], fromEmail: 'me@elsewhere.com'}),
      ).rejects.toMatchObject({code: 403});
    });
  });

  describe('test alert', () => {
    it('reports what SES says, and allows one a minute', async () => {
      rejectFirst('Email address is not verified.');
      await expect(FailureAlertService.sendTest(projectId)).rejects.toThrow('Email address is not verified.');

      await expect(FailureAlertService.sendTest(projectId)).rejects.toMatchObject({code: 429});
    });

    it('goes from the saved sender only, so a sender whose domain is not verified shows up', async () => {
      await factories.createDomain({projectId, domain: 'other.example.com'});
      await prisma.domain.updateMany({where: {projectId, domain: 'example.com'}, data: {verified: false}});

      await expect(FailureAlertService.sendTest(projectId)).rejects.toMatchObject({
        code: 403,
        message: 'The domain of alerts@example.com is not verified',
      });
      expect(alerts()).toEqual([]);
    });

    it('needs addresses first', async () => {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      await expect(FailureAlertService.sendTest(projectId)).rejects.toMatchObject({code: 400});
    });
  });
});
