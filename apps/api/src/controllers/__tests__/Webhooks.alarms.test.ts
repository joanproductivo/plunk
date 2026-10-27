import {randomUUID} from 'node:crypto';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FailureAlertService} from '../../services/FailureAlertService';
import {getAwsAccountId, sendRawEmail} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {FOREIGN_TOPIC, postSns} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
  sendRawEmail: vi.fn(async () => ({messageId: 'alert-message-id'})),
}));

const ALARMS_TOPIC = 'arn:aws:sns:eu-north-1:111111111111:plunk-alarmas';

/**
 * The AWS account's CloudWatch alarms, delivered by their own topic to the SES webhook, shown on
 * every project's dashboard: an alarm opens a notice, its return to OK closes it.
 */
describe('Webhooks - CloudWatch alarms', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let alarmName: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
    await prisma.plunkLiteAlertSettings.create({
      data: {projectId, recipients: ['ops@example.org'], fromEmail: 'alerts@example.com'},
    });
    vi.spyOn(SnsSignature, 'verify').mockResolvedValue('valid');
    vi.mocked(getAwsAccountId).mockResolvedValue('111111111111');
    // The last state change of an alarm is kept in Redis, which outlives a run of the suite
    alarmName = `ses-rebotes-alto-${randomUUID()}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A CloudWatch alarm notification, as SNS posts it */
  const alarm = (state: string, changedAt: Date, overrides: Record<string, unknown> = {}, topicArn = ALARMS_TOPIC) =>
    postSns({
      Type: 'Notification',
      TopicArn: topicArn,
      MessageId: randomUUID(),
      Message: JSON.stringify({
        AlarmName: alarmName,
        AlarmArn: `arn:aws:cloudwatch:eu-north-1:111111111111:alarm:${alarmName}`,
        AWSAccountId: '111111111111',
        NewStateValue: state,
        NewStateReason: 'Threshold Crossed: 1 datapoint [0.05] was greater than or equal to the threshold (0.04).',
        StateChangeTime: changedAt.toISOString().replace('Z', '+0000'),
        ...overrides,
      }),
    });

  const openAlarms = async (id = projectId) =>
    (await FailureAlertService.listOpen(id)).filter(failure => failure.sourceKey === `aws:alarm:${alarmName}`);

  it('shows an alarm in every project, disabled ones included, without emailing', async () => {
    const {project: disabled} = await factories.createUserWithProject({}, {disabled: true});

    const captured = await alarm('ALARM', new Date());

    expect(captured.status).toBe(200);
    const [open] = await openAlarms();
    expect(open).toMatchObject({label: alarmName, reviewPath: '/settings?tab=security'});
    expect(open!.lastError).toContain('Threshold Crossed');
    expect(await openAlarms(disabled.id)).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(sendRawEmail).not.toHaveBeenCalled();
  });

  it('closes it when the alarm is OK again, and opens it again on the next alarm', async () => {
    const start = Date.now();
    await alarm('ALARM', new Date(start));

    await alarm('OK', new Date(start + 60_000));
    expect(await openAlarms()).toEqual([]);

    await alarm('ALARM', new Date(start + 120_000));
    expect(await openAlarms()).toMatchObject([{count: 1}]);
  });

  it('ignores a state change older than the last one applied', async () => {
    const start = Date.now();
    await alarm('OK', new Date(start + 60_000));

    await alarm('ALARM', new Date(start));

    expect(await openAlarms()).toEqual([]);
  });

  it('applies once a state change whose copies arrive together', async () => {
    const changedAt = new Date();

    await Promise.all([alarm('ALARM', changedAt), alarm('ALARM', changedAt), alarm('ALARM', changedAt)]);

    expect(await openAlarms()).toMatchObject([{count: 1}]);
  });

  it('changes nothing for INSUFFICIENT_DATA', async () => {
    await alarm('ALARM', new Date());

    await alarm('INSUFFICIENT_DATA', new Date(Date.now() + 60_000));

    expect(await openAlarms()).toHaveLength(1);
  });

  it('rejects an alarm from a topic of another account, as any other message', async () => {
    const captured = await alarm('ALARM', new Date(), {AWSAccountId: '999999999999'}, FOREIGN_TOPIC);

    expect(captured.status).toBe(403);
    expect(await openAlarms()).toEqual([]);
  });

  it('does not take for an alarm a message that names another account', async () => {
    const captured = await alarm('ALARM', new Date(), {AWSAccountId: '999999999999'});

    expect(captured.status).toBe(200);
    expect(await openAlarms()).toEqual([]);
  });

  it('confirms the subscription of the alarms topic of its own account', async () => {
    const confirm = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', confirm);

    const captured = await postSns({
      Type: 'SubscriptionConfirmation',
      TopicArn: ALARMS_TOPIC,
      SubscribeURL: 'https://sns.eu-north-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc',
    });

    expect(captured.status).toBe(200);
    expect(confirm).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  // Failures are Plunk Lite's own table, which the suite does not empty between tests
  const failures = (sourceKey: string, projectIds = [projectId]) =>
    prisma.plunkLiteFailure.findMany({where: {sourceKey, projectId: {in: projectIds}}});

  it('only logs a message of the alarms topic that is not JSON', async () => {
    const captured = await postSns({
      Type: 'Notification',
      TopicArn: ALARMS_TOPIC,
      MessageId: randomUUID(),
      Message: 'A plain-text message published to the topic by hand',
    });

    expect(captured.status).toBe(200);
    expect(await failures('sns:invalid')).toEqual([]);
  });

  it('shows in every project, without emailing, that the alarms no longer reach the dashboard when its subscription is removed', async () => {
    const {project: disabled} = await factories.createUserWithProject({}, {disabled: true});

    const captured = await postSns({Type: 'UnsubscribeConfirmation', TopicArn: ALARMS_TOPIC});

    expect(captured.status).toBe(200);
    const recorded = await failures('aws:alarm-subscription', [projectId, disabled.id]);
    expect(recorded.map(failure => failure.projectId).sort()).toEqual([projectId, disabled.id].sort());
    expect(recorded[0]).toMatchObject({label: 'AWS alarms no longer reach the dashboard; their emails still do'});
    expect(recorded[0]!.lastError).toContain(ALARMS_TOPIC);
    expect(await failures('sns:subscription')).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(sendRawEmail).not.toHaveBeenCalled();
  });
});
