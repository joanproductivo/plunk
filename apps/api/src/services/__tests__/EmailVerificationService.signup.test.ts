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
    resolveMx = vi
      .spyOn(dns.Resolver.prototype, 'resolveMx')
      .mockResolvedValue([{exchange: 'mx.example.org', priority: 10}]);
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

  it('refuses a domain that does not exist', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));

    const verdict = await EmailVerificationService.verifySignup('ana@shop-that-does-not-exist.test');

    expect(verdict).toEqual({valid: false, reasons: ['Domain does not exist']});
  });

  it.each(['gmial.com', 'gamil.com', 'gmai.com', 'hotmial.com', 'hotmal.es', 'outlok.com', 'iclod.com', 'yaho.es'])(
    'refuses %s, a slip of a large provider, with the correction and without asking DNS',
    async domain => {
      const verdict = await EmailVerificationService.verifySignup(`ana@${domain}`);

      expect(verdict.valid).toBe(false);
      expect(verdict.reasons[0]).toMatch(/^Looks like a typo of /);
      expect(verdict.suggestedEmail).toMatch(/^ana@(gmail|hotmail|outlook|icloud|yahoo)\./);
      expect(resolveMx).not.toHaveBeenCalled();
    },
  );

  it.each([
    'foxmail.com',
    'hotmart.com',
    'uah.es',
    'msc.com',
    'ms.com',
    'ge.com',
    'cloud.com',
    'email.com',
    'usa.com',
    'protonmail.ch',
    'yahoo.com.mx',
    'live.com.mx',
    'gmx.net',
    'hotmail.fr',
    'grail.com',
    'wahoo.com',
    'dcloud.com',
    'qmail.com',
  ])('accepts %s, a real domain the spell checker takes for a large provider or close to one', async domain => {
    expect((await EmailVerificationService.verifySignup(`ana@${domain}`)).valid).toBe(true);
  });

  it('suggests a correction only towards a large provider', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));

    // The spell checker would say mail.es
    expect(await EmailVerificationService.verifySignup('ana@gmail.es')).toEqual({
      valid: false,
      reasons: ['Domain cannot receive email (no MX or address records)'],
    });
  });

  it.each(['', '.', 'localhost', 'localhost.', '127.0.0.1', '0.0.0.0'])(
    'refuses a domain whose MX points nowhere (%s)',
    async exchange => {
      resolveMx.mockResolvedValue([{exchange, priority: 0}]);

      expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(false);
    },
  );

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

  it('accepts the address when a DNS lookup throws', async () => {
    resolveMx.mockImplementation(() => {
      throw new TypeError('boom');
    });

    expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
  });

  it('accepts the address on an unexpected error outside DNS', async () => {
    vi.spyOn(
      EmailVerificationService as unknown as {isDisposableDomain: () => Promise<boolean>},
      'isDisposableDomain',
    ).mockRejectedValue(new Error('boom'));

    expect((await EmailVerificationService.verifySignup('ana@shop.org')).valid).toBe(true);
  });

  it("remembers a domain's clear answer for 10 minutes, and an uncertain one for a minute", async () => {
    vi.useFakeTimers({toFake: ['Date']});
    await EmailVerificationService.verifySignup('ana@shop.org');
    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
    await EmailVerificationService.verifySignup('ana@other.org');
    await EmailVerificationService.verifySignup('luis@shop.org');
    await EmailVerificationService.verifySignup('luis@other.org');
    expect(resolveMx).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(61_000);
    await EmailVerificationService.verifySignup('eva@shop.org');
    await EmailVerificationService.verifySignup('eva@other.org');
    expect(resolveMx).toHaveBeenCalledTimes(3);
  });

  it('never refuses the largest providers, whatever DNS or the disposable list say', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    caches.disposableDomainsSet = new Set(['gmail.com']);

    expect(await EmailVerificationService.verifySignup('ana@Gmail.com')).toEqual({valid: true, reasons: []});
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('looks up the domains of several addresses at once, once each, and not the slips', async () => {
    await EmailVerificationService.prefetchSignupDomains(['a@shop.org', 'b@shop.org', 'c@other.org', 'e@gmial.com']);
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
      ContactService.upsert(projectId, 'ana@shop-that-does-not-exist.test', undefined, undefined, true, {
        verifySignup: true,
      }),
    ).rejects.toMatchObject({code: 422, errorCode: 'INVALID_EMAIL', details: {reasons: ['Domain does not exist']}});

    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
  });

  it('refuses a slip of a large provider with the correction in the details, not in the message', async () => {
    const refusal = ContactService.upsert(projectId, 'ana@gmial.com', undefined, undefined, true, {
      verifySignup: true,
    });

    await expect(refusal).rejects.toMatchObject({
      code: 422,
      details: {reasons: ['Looks like a typo of gmail.com'], suggestedEmail: 'ana@gmail.com'},
    });
    await expect(refusal).rejects.toSatisfy((error: Error) => !error.message.includes('@'));
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
