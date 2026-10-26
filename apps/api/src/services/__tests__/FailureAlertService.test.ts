import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as servicePrisma} from '../../database/prisma';
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
      expect(sendRawEmail).toHaveBeenCalledTimes(2); // one per address
    });

    it("does not review another project's failures", async () => {
      await fail();
      const [seen] = await FailureAlertService.listOpen(projectId);
      const {project: other} = await factories.createUserWithProject();

      expect(await FailureAlertService.review(other.id, [{id: seen!.id, lastAt: seen!.lastAt}])).toBe(0);
      expect(await FailureAlertService.listOpen(projectId)).toHaveLength(1);
    });

    it('never throws, whatever goes wrong', async () => {
      vi.spyOn(servicePrisma, '$queryRaw').mockRejectedValueOnce(new Error('database down'));
      await expect(fail()).resolves.toBeUndefined();
    });
  });

  describe('alerting', () => {
    it('emails each address once for failures arriving together, then not again within the hour', async () => {
      await Promise.all([fail(), fail(), fail()]);
      await settle();

      expect(sendRawEmail).toHaveBeenCalledTimes(2);
      const recipients = vi.mocked(sendRawEmail).mock.calls.map(([params]) => params.to);
      expect(recipients).toEqual(expect.arrayContaining([['ops@example.org'], ['boss@example.org']]));

      await fail();
      await settle();
      expect(sendRawEmail).toHaveBeenCalledTimes(2);
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

      expect(sendRawEmail).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sendRawEmail).mock.calls[0]![0].content.html).toContain('Failed 3 times');
    });

    it('keeps emailing the other addresses when one is rejected', async () => {
      vi.mocked(sendRawEmail).mockRejectedValueOnce(new Error('Email address is not verified.'));

      await fail();
      await settle();

      expect(sendRawEmail).toHaveBeenCalledTimes(2);
    });

    it('says what failed in the subject', async () => {
      await fail();
      await fail('x', 'transactional');
      await settle();

      const subjects = vi.mocked(sendRawEmail).mock.calls.map(([params]) => params.content.subject);
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
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });

    it('sends at most ten alerts an hour per project, however many sources fail', async () => {
      await prisma.plunkLiteAlertSettings.update({where: {projectId}, data: {recipients: ['ops@example.org']}});
      for (let n = 0; n < 12; n++) {
        await fail('x', `workflow:00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`);
      }
      await settle();

      expect(sendRawEmail).toHaveBeenCalledTimes(10);
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

      const [params] = vi.mocked(sendRawEmail).mock.calls[0]!;
      expect(params.content.subject).toContain('Ha fallado: Workflow «<b>Welcome</b>»');
      expect(params.content.html).not.toContain('<script>');
      expect(params.content.html).toContain('&lt;script&gt;');
      expect(params.content.html).toContain('Ha fallado 1 vez');
      expect(params.headers).toMatchObject({'Auto-Submitted': 'auto-generated'});
      expect(params.tracking).toBe(false);
    });

    it('records but sends nothing without addresses, for a disabled project, or from an unverified domain', async () => {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      await fail();
      await settle();
      expect(sendRawEmail).not.toHaveBeenCalled();

      await prisma.plunkLiteAlertSettings.create({
        data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
      });
      await prisma.project.update({where: {id: projectId}, data: {disabled: true}});
      await fail('x', 'transactional');
      await settle();
      expect(sendRawEmail).not.toHaveBeenCalled();

      await prisma.project.update({where: {id: projectId}, data: {disabled: false}});
      await prisma.domain.updateMany({where: {projectId}, data: {verified: false}});
      await fail('x', 'project');
      await settle();
      expect(sendRawEmail).not.toHaveBeenCalled();
      expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(3);
    });
  });

  describe('sources', () => {
    it('records a project disabled for its content, without emailing from the disabled project', async () => {
      await SecurityService.disableProjectForPhishing(projectId, 'Subject', 99);
      await settle();

      expect(await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'project'}})).toMatchObject({
        label: 'Project disabled',
      });
      expect(sendRawEmail).not.toHaveBeenCalled();
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
      vi.mocked(sendRawEmail).mockRejectedValueOnce(new Error('Email address is not verified.'));
      await expect(FailureAlertService.sendTest(projectId)).rejects.toThrow('Email address is not verified.');

      await expect(FailureAlertService.sendTest(projectId)).rejects.toMatchObject({code: 429});
    });

    it('needs addresses first', async () => {
      await prisma.plunkLiteAlertSettings.deleteMany({where: {projectId}});
      await expect(FailureAlertService.sendTest(projectId)).rejects.toMatchObject({code: 400});
    });
  });
});
