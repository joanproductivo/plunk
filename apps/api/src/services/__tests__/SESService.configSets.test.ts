import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {checkConfigurationSets} from '../SesEventMatch';
import {ses, verifyConfigurationSets} from '../SESService';

const TOPIC = 'arn:aws:sns:eu-north-1:111111111111:plunk-ses-events';

/** A configuration set as DescribeConfigurationSet returns it */
function described(destinations: {Enabled?: boolean; MatchingEventTypes?: string[]; SNSDestination?: object}[]) {
  return {
    EventDestinations: destinations.map((destination, i) => ({Name: `destination-${i}`, ...destination})),
  } as never;
}

const PUBLISHING = {
  Enabled: true,
  MatchingEventTypes: ['bounce', 'complaint', 'delivery', 'open', 'click'],
  SNSDestination: {TopicARN: TOPIC},
};

/**
 * Plunk Lite: at startup, each configuration set Plunk sends through must publish its bounces,
 * complaints and deliveries to SNS; one that does not loses every bounce without a sign.
 */
describe('verifyConfigurationSets', () => {
  const describeSet = vi.spyOn(ses, 'describeConfigurationSet');

  afterEach(() => {
    describeSet.mockReset();
  });

  it('finds nothing wrong when both sets publish to SNS', async () => {
    describeSet.mockResolvedValue(described([PUBLISHING]));

    await expect(verifyConfigurationSets()).resolves.toEqual([]);
    expect(describeSet).toHaveBeenCalledWith({
      ConfigurationSetName: 'test',
      ConfigurationSetAttributeNames: ['eventDestinations'],
    });
    expect(describeSet).toHaveBeenCalledWith(expect.objectContaining({ConfigurationSetName: 'test-no-tracking'}));
  });

  it.each([
    ['without bounces', {...PUBLISHING, MatchingEventTypes: ['complaint', 'delivery']}],
    ['without complaints', {...PUBLISHING, MatchingEventTypes: ['bounce', 'delivery']}],
    ['disabled', {...PUBLISHING, Enabled: false}],
    ['to CloudWatch instead of SNS', {Enabled: true, MatchingEventTypes: PUBLISHING.MatchingEventTypes}],
  ])('names a set whose destination is %s', async (_case, destination) => {
    describeSet.mockResolvedValueOnce(described([destination])).mockResolvedValueOnce(described([PUBLISHING]));

    const problems = await verifyConfigurationSets();

    expect(problems).toEqual([
      'Configuration set "test" from SES_CONFIGURATION_SET has no enabled SNS event destination publishing bounce, complaint, delivery events: no bounce or complaint of its emails reaches Plunk.',
    ]);
  });

  it('names a set that does not exist', async () => {
    describeSet
      .mockResolvedValueOnce(described([PUBLISHING]))
      .mockRejectedValueOnce(Object.assign(new Error('missing'), {name: 'ConfigurationSetDoesNotExistException'}));

    expect(await verifyConfigurationSets()).toEqual([expect.stringMatching(/^Configuration set "test-no-tracking"/)]);
  });

  it('cannot tell without permission to describe the sets', async () => {
    describeSet.mockRejectedValue(Object.assign(new Error('denied'), {name: 'AccessDeniedException'}));

    await expect(verifyConfigurationSets()).resolves.toBeUndefined();
  });
});

describe('checkConfigurationSets', () => {
  const prisma = getPrismaClient();
  const describeSet = vi.spyOn(ses, 'describeConfigurationSet');
  let projectId: string;

  beforeEach(async () => {
    projectId = (await factories.createUserWithProject()).project.id;
  });

  afterEach(() => {
    describeSet.mockReset();
  });

  const notice = () => prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'sns:config'}});

  it('tells every project about a set that does not publish, and closes it once they all do', async () => {
    describeSet.mockResolvedValue(described([{...PUBLISHING, Enabled: false}]));
    await checkConfigurationSets();
    expect((await notice())?.label).toBe('SES configuration sets');

    describeSet.mockResolvedValue(described([PUBLISHING]));
    await checkConfigurationSets();
    const closed = (await notice())!;
    expect(closed.reviewedAt).toEqual(closed.lastAt);
  });

  it('changes nothing when SES could not be asked', async () => {
    describeSet.mockRejectedValue(Object.assign(new Error('denied'), {name: 'AccessDeniedException'}));

    await checkConfigurationSets();

    expect(await notice()).toBeNull();
  });
});
