import {promises as dns} from 'dns';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ContactService} from '../ContactService';
import {EmailVerificationService} from '../EmailVerificationService';

/** A DNS error as Node's resolver raises it */
const dnsError = (code: string) => Object.assign(new Error(`queryMx ${code}`), {code});

/** The service's private caches, reset between tests */
const caches = EmailVerificationService as unknown as {
  disposableDomainsSet: Set<string> | null;
  signupDomains: Map<string, unknown>;
};

/**
 * Plunk Lite: a new contact from the API needs an address whose domain takes email. Only clear
 * answers refuse it; anything uncertain lets it in.
 */
describe('EmailVerificationService.verifySignup', () => {
  let resolveMx: ReturnType<typeof vi.spyOn>;
  let resolve4: ReturnType<typeof vi.spyOn>;
  let resolve6: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    caches.disposableDomainsSet = new Set(['mailinator.com']);
    caches.signupDomains.clear();
    resolveMx = vi.spyOn(dns.Resolver.prototype, 'resolveMx').mockResolvedValue([{exchange: 'mx.example.org', priority: 10}]);
    resolve4 = vi.spyOn(dns.Resolver.prototype, 'resolve4').mockRejectedValue(dnsError('ENODATA'));
    resolve6 = vi.spyOn(dns.Resolver.prototype, 'resolve6').mockRejectedValue(dnsError('ENODATA'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    caches.disposableDomainsSet = null;
  });

  it('accepts a domain with MX records', async () => {
    expect(await EmailVerificationService.verifySignup('ana@shop.org')).toEqual({valid: true, reasons: []});
  });

  it('refuses a domain that does not exist, suggesting the likely address', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));

    const verdict = await EmailVerificationService.verifySignup('ana@gmial.com');

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(['Domain does not exist']);
    expect(verdict.suggestedEmail).toBe('ana@gmail.com');
  });

  it('refuses a domain that declares it takes no email (null MX)', async () => {
    resolveMx.mockResolvedValue([{exchange: '', priority: 0}]);

    expect((await EmailVerificationService.verifySignup('ana@example.com')).valid).toBe(false);
  });

  it('accepts a domain without MX records that has an address record', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    resolve4.mockResolvedValue(['192.0.2.1']);

    expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
  });

  it('refuses a domain with neither MX nor address records', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));

    const verdict = await EmailVerificationService.verifySignup('ana@shop.org');

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons[0]).toContain('no MX or address records');
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'EBADRESP', 'EBADNAME', 'ECANCELLED'])(
    'accepts the address when DNS fails with %s',
    async code => {
      resolveMx.mockRejectedValue(dnsError(code));

      expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
    },
  );

  it('accepts the address when no address record lookup can say', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    resolve6.mockRejectedValue(dnsError('ETIMEOUT'));

    expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
  });

  it('accepts the address when DNS does not answer within 2 seconds', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    resolveMx.mockReturnValue(new Promise(() => undefined));

    const verdict = EmailVerificationService.verifySignup('ana@shop.org');
    await vi.advanceTimersByTimeAsync(2000);

    expect((await verdict).valid).toBe(true);
  });

  it('refuses a disposable domain', async () => {
    const verdict = await EmailVerificationService.verifySignup('ana@mailinator.com');

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toContain('Disposable email addresses are not accepted');
  });

  it('accepts the address on an unexpected error', async () => {
    resolveMx.mockImplementation(() => {
      throw new TypeError('boom');
    });

    expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
  });

  it("remembers a domain's clear answer, but not an uncertain one", async () => {
    await EmailVerificationService.verifySignup('ana@shop.org');
    await EmailVerificationService.verifySignup('luis@shop.org');
    expect(resolveMx).toHaveBeenCalledTimes(1);

    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
    await EmailVerificationService.verifySignup('ana@other.org');
    await EmailVerificationService.verifySignup('luis@other.org');
    expect(resolveMx).toHaveBeenCalledTimes(3);
  });

  it('looks up the domains of several addresses at once, once each', async () => {
    await EmailVerificationService.prefetchSignupDomains(['a@shop.org', 'b@shop.org', 'c@other.org']);
    await EmailVerificationService.verifySignup('d@other.org');

    expect(resolveMx).toHaveBeenCalledTimes(2);
  });
});

describe('ContactService.upsert with verifySignup', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let resolveMx: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
    caches.disposableDomainsSet = new Set();
    caches.signupDomains.clear();
    resolveMx = vi.spyOn(dns.Resolver.prototype, 'resolveMx').mockRejectedValue(dnsError('ENOTFOUND'));
    process.env.PLUNK_LITE_VERIFY_SIGNUPS = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    caches.disposableDomainsSet = null;
    process.env.PLUNK_LITE_VERIFY_SIGNUPS = 'false';
  });

  it('refuses a new contact whose domain does not exist, with the reasons, and creates nothing', async () => {
    await expect(
      ContactService.upsert(projectId, 'ana@gmial.com', undefined, undefined, true, {verifySignup: true}),
    ).rejects.toMatchObject({
      code: 422,
      errorCode: 'INVALID_EMAIL',
      details: {reasons: ['Domain does not exist'], suggestedEmail: 'ana@gmail.com'},
    });

    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
  });

  it('never verifies a contact that already exists', async () => {
    await prisma.contact.create({data: {projectId, email: 'ana@gmial.com'}});

    await ContactService.upsert(projectId, 'ana@gmial.com', {plan: 'pro'}, undefined, true, {verifySignup: true});

    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('verifies nothing when switched off, or for callers that do not ask', async () => {
    await ContactService.upsert(projectId, 'imported@gmial.com');
    process.env.PLUNK_LITE_VERIFY_SIGNUPS = 'false';
    await ContactService.upsert(projectId, 'ana@gmial.com', undefined, undefined, true, {verifySignup: true});

    expect(resolveMx).not.toHaveBeenCalled();
    expect(await prisma.contact.count({where: {projectId}})).toBe(2);
  });
});
