import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import * as SESService from '../../services/SESService.js';
import {checkDomainVerifications} from '../domain-verification.js';

/**
 * The domain verification job, run every 5 minutes: what it does when SES stops verifying a domain
 * (Plunk Lite's failure alerts).
 */
describe('checkDomainVerifications', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    // The job must not reach AWS
    vi.spyOn(SESService, 'verifyDomain').mockResolvedValue(['token1']);
    vi.spyOn(SESService, 'disableFeedbackForwarding').mockResolvedValue(undefined);
  });

  it('records a domain SES stopped verifying, once', async () => {
    const domain = await factories.createDomain({projectId, domain: 'lost.example.com'});
    vi.spyOn(SESService, 'getIdentities').mockResolvedValue([{domain: 'lost.example.com', status: 'Failed'}]);

    await checkDomainVerifications();

    expect((await prisma.domain.findUniqueOrThrow({where: {id: domain.id}})).verified).toBe(false);
    const failure = await prisma.plunkLiteFailure.findFirstOrThrow({
      where: {projectId, sourceKey: `domain:${domain.id}`},
    });
    expect(failure).toMatchObject({label: 'lost.example.com', count: 1});
    expect(failure.lastError).toContain('SES reports the domain as Failed');

    // Still not verified on the next run: no new failure
    await checkDomainVerifications();
    expect(await prisma.plunkLiteFailure.findFirstOrThrow({where: {projectId}})).toMatchObject({count: 1});
  });

  it('records nothing for a domain that stays verified', async () => {
    await factories.createDomain({projectId, domain: 'kept.example.com'});
    vi.spyOn(SESService, 'getIdentities').mockResolvedValue([{domain: 'kept.example.com', status: 'Success'}]);

    await checkDomainVerifications();

    expect(await prisma.plunkLiteFailure.count({where: {projectId}})).toBe(0);
  });
});
