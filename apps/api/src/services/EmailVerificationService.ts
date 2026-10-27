import {promises as dns} from 'dns';
import {run} from '@zootools/email-spell-checker';
import type {EmailVerificationResult} from '@plunk/types';
import signale from 'signale';
import {redis, redisReady} from '../database/redis.js';

const DISPOSABLE_DOMAINS_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const DISPOSABLE_DOMAINS_CACHE_KEY = 'email:disposable_domains';
const PERSONAL_DOMAINS_URL =
  'https://gist.githubusercontent.com/ammarshah/f5c2624d767f91a7cbdc4e54db8dd0bf/raw/660fd949eba09c0b86574d9d3aa0f2137161fc7c/all_email_provider_domains.txt';
const PERSONAL_DOMAINS_CACHE_KEY = 'email:personal_domains';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours (list updates daily)
// Plunk Lite: a list download that hangs must not hold up a sign-up, and one that failed is not
// tried again on every request
const LIST_DOWNLOAD_TIMEOUT_MS = 2000;
const LIST_RETRY_AFTER_MS = 10 * 60 * 1000;

// Plunk Lite: the DNS lookups of a sign-up's domain, each try and all of them together
const SIGNUP_DNS_TRY_TIMEOUT_MS = 1000;
const SIGNUP_DNS_DEADLINE_MS = 2000;
// Domains whose answer was clear, for a while: most sign-ups share a handful of providers
const SIGNUP_DOMAIN_CACHE_MS = 10 * 60 * 1000;
const SIGNUP_DOMAIN_UNCERTAIN_MS = 60 * 1000;
const SIGNUP_DOMAIN_CACHE_MAX = 5000;

// Plunk Lite: the largest mailbox providers, never refused at sign-up: a resolver that answers wrongly,
// or a bad change to the disposable list, must not turn away most of a form's sign-ups
const NEVER_REFUSED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.es',
  'hotmail.com',
  'hotmail.es',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.es',
  'telefonica.net',
]);

/** The domain of an address, lowercased; empty if it has none */
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

// An MX that points nowhere: the null MX of RFC 7505 ('' or '.'), or this very machine
const NO_MAIL_EXCHANGES = new Set(['', 'localhost', '127.0.0.1', '0.0.0.0']);

// Real domains the spell checker takes for a large provider's, one letter away
const NOT_SLIPS = new Set(['email.com', 'cloud.com']);

/**
 * Plunk Lite: whether a domain is a slip of a large provider's that the spell checker suggests: the
 * same ending, and a first label one edit away (a letter added, dropped, changed or two swapped) from
 * a provider name of at least five letters. Measured over 330 real domains and every 2-3 letter
 * label: shorter names (me, msn, live) and wider distances caught real ones -- foxmail.com, uah.es,
 * msc.com, ge.com -- where this catches none and still catches gmial.com, hotmal.es or iclod.com.
 */
function isLargeProviderSlip(typed: string, suggested: string): boolean {
  if (typed === suggested || !NEVER_REFUSED_DOMAINS.has(suggested) || NOT_SLIPS.has(typed)) {
    return false;
  }
  const typedDot = typed.indexOf('.');
  const suggestedDot = suggested.indexOf('.');
  if (typedDot < 0 || typed.slice(typedDot) !== suggested.slice(suggestedDot)) {
    return false;
  }
  const label = suggested.slice(0, suggestedDot);
  return label.length >= 5 && editDistance(typed.slice(0, typedDot), label) <= 1;
}

/** Edits between two strings, a swap of neighbours counting as one (optimal string alignment) */
function editDistance(a: string, b: string): number {
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** Plunk Lite: whether a new contact's address may be added, and if not, why */
export interface SignupVerdict {
  valid: boolean;
  reasons: string[];
  suggestedEmail?: string;
}

// Known email forwarding/alias services
const FORWARDING_DOMAINS = new Set([
  'privaterelay.appleid.com', // Apple Sign In
  'mozmail.com', // Firefox Relay
  'simplelogin.com', // SimpleLogin
  'simplelogin.fr',
  'simplelogin.co',
  'simplelogin.io',
  'aleeas.com',
  'slmail.me',
  'dralias.com',
  '8shield.net',
  'anonaddy.com', // Addy.io
  'anonaddy.me',
  'addy.io',
  'duck.com', // DuckDuckGo
  '33mail.com', // 33mail
  '33m.co',
  'passmail.com', // Proton Pass
  'passmail.net',
  'passinbox.com',
  'passfwd.com',
  'y.yo.fr',
  'opayq.com', // IronVest (formerly Blur)
  'cloak.id', // Cloaked
  'erine.email', // Erine
  'use.startmail.com', // StartMail
]);

export class EmailVerificationService {
  private static disposableDomainsSet: Set<string> | null = null;
  private static disposableDomainsFailedAt: number | null = null;
  private static personalDomainsSet: Set<string> | null = null;
  /** Plunk Lite: a domain's answer -- why it takes no email, null if it does, undefined if DNS could not say */
  private static signupDomains = new Map<string, {reason: string | null | undefined; expiresAt: number}>();
  private static disposableDomainsLoading: Promise<Set<string>> | null = null;

  /**
   * Plunk Lite: whether a new contact's address may be added. Refused only when the answer is
   * clear: a slip of a large provider's name (gmial.com), a disposable domain, a domain that does
   * not exist, one that declares it takes no email (a null MX, RFC 7505), or one with neither MX
   * nor address records. Anything uncertain -- a DNS server that times out or fails, an unexpected
   * error -- lets the address in: a sign-up is never lost to a lookup. The largest providers are
   * never refused, whatever DNS or the disposable list say. An inbox that does not exist on a real
   * domain is not caught.
   */
  static async verifySignup(email: string): Promise<SignupVerdict> {
    const domain = domainOf(email);
    try {
      if (!domain || NEVER_REFUSED_DOMAINS.has(domain)) {
        return {valid: true, reasons: []};
      }

      // Slips of a large provider's name are registered by others: some only have a website, so
      // DNS alone would let them in, and some take mail -- the customer's, for a stranger
      const typo = run({email});
      if (typo?.full && isLargeProviderSlip(domain, typo.domain)) {
        return {valid: false, reasons: [`Looks like a typo of ${typo.domain}`], suggestedEmail: typo.full};
      }

      const reasons: string[] = [];
      if (await this.isDisposableDomain(domain)) {
        reasons.push('Disposable email addresses are not accepted');
      }
      const domainReason = await this.signupDomainReason(domain);
      if (domainReason) {
        reasons.push(domainReason);
      }
      if (reasons.length === 0) {
        return {valid: true, reasons};
      }

      // A correction only towards a large provider: for other domains the guess is often wrong
      // (gmail.es would become mail.es)
      return {
        valid: false,
        reasons,
        ...(typo?.full && NEVER_REFUSED_DOMAINS.has(typo.domain) ? {suggestedEmail: typo.full} : {}),
      };
    } catch (error) {
      signale.warn(
        `[VERIFY] Could not verify an address on ${domain}, letting it in: ${error instanceof Error ? error.message : error}`,
      );
      return {valid: true, reasons: []};
    }
  }

  /** Plunk Lite: look up these addresses' domains at once, so verifying each one later is quick */
  static async prefetchSignupDomains(emails: string[]): Promise<void> {
    const domains = new Set(
      emails
        .filter(email => {
          const typo = run({email});
          return !(typo?.full && isLargeProviderSlip(domainOf(email), typo.domain));
        })
        .map(domainOf)
        .filter(domain => domain && !NEVER_REFUSED_DOMAINS.has(domain)),
    );
    await Promise.all([...domains].map(domain => this.signupDomainReason(domain).catch(() => undefined)));
  }

  /** Plunk Lite: fetch the disposable domains list ahead of the first sign-up */
  static async warmUp(): Promise<void> {
    await this.getDisposableDomains();
  }

  /**
   * Why a domain takes no email, null if it does, undefined if DNS could not say. A clear answer
   * is remembered for 10 minutes; an uncertain one for a minute, so a DNS outage costs each domain
   * one lookup a minute rather than one per sign-up.
   */
  private static async signupDomainReason(domain: string): Promise<string | null | undefined> {
    const cached = this.signupDomains.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.reason;
    }

    // A resolver per lookup: cancelling it at the deadline must not cancel other requests' lookups
    const resolver = new dns.Resolver({timeout: SIGNUP_DNS_TRY_TIMEOUT_MS, tries: 2});
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), SIGNUP_DNS_DEADLINE_MS);
    });
    try {
      const reason = await Promise.race([this.lookUpSignupDomain(resolver, domain), deadline]);
      // At the cap, the oldest goes: a Map keeps insertion order, and the large providers never get here
      if (this.signupDomains.size >= SIGNUP_DOMAIN_CACHE_MAX) {
        const oldest = this.signupDomains.keys().next().value;
        if (oldest !== undefined) {
          this.signupDomains.delete(oldest);
        }
      }
      this.signupDomains.delete(domain);
      const keepFor = reason === undefined ? SIGNUP_DOMAIN_UNCERTAIN_MS : SIGNUP_DOMAIN_CACHE_MS;
      this.signupDomains.set(domain, {reason, expiresAt: Date.now() + keepFor});
      return reason;
    } finally {
      clearTimeout(timer);
      // Ends the lookups still pending after the deadline; their rejections are already handled
      resolver.cancel();
    }
  }

  private static async lookUpSignupDomain(resolver: dns.Resolver, domain: string): Promise<string | null | undefined> {
    try {
      const mx = await resolver.resolveMx(domain);
      if (mx.length > 0) {
        return mx.every(record => NO_MAIL_EXCHANGES.has(record.exchange.toLowerCase().replace(/\.$/, '')))
          ? 'Domain does not accept email (its MX record points nowhere)'
          : null;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND') {
        return 'Domain does not exist';
      }
      if (code !== 'ENODATA') {
        return undefined;
      }
    }

    // Without MX records, mail goes to the domain's own address (RFC 5321 section 5.1)
    const lookups = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
    if (lookups.some(lookup => lookup.status === 'fulfilled' && lookup.value.length > 0)) {
      return null;
    }
    const noRecords = lookups.every(
      lookup =>
        lookup.status === 'fulfilled' ||
        ['ENODATA', 'ENOTFOUND'].includes((lookup.reason as NodeJS.ErrnoException).code ?? ''),
    );
    return noRecords ? 'Domain cannot receive email (no MX or address records)' : undefined;
  }

  /**
   * Verify an email address
   * - Checks for NS records (proves domain exists in DNS)
   * - Checks for MX records (required for receiving email)
   * - Checks for A/AAAA records (informational - indicates if domain has a website)
   * - Detects disposable email addresses
   * - Detects personal/free email providers (Gmail, Hotmail, etc.)
   * - Detects forwarding/alias email addresses
   * - Suggests corrections for common typos
   */
  static async verifyEmail(email: string): Promise<EmailVerificationResult> {
    const result: EmailVerificationResult = {
      email,
      valid: true,
      isDisposable: false,
      isAlias: false,
      isTypo: false,
      isPlusAddressed: false,
      isPersonalEmail: false,
      domainExists: false,
      hasWebsite: false,
      hasMxRecords: false,
      reasons: [],
    };

    // Extract domain from email
    const emailParts = email.split('@');
    if (emailParts.length !== 2) {
      result.valid = false;
      result.reasons.push('Invalid email format');
      return result;
    }

    const domain = emailParts[1]!; // Safe to assert, we already validated length

    // Check if email is from a disposable domain using GitHub list
    result.isDisposable = await this.isDisposableDomain(domain);

    // Check if email is from a personal/free email provider
    result.isPersonalEmail = await this.isPersonalEmailDomain(domain);

    // Check if email is from a known forwarding/alias service
    result.isAlias = this.isForwardingDomain(domain);

    // Check for plus addressing
    result.isPlusAddressed = emailParts[0]!.includes('+');

    // Check for common typos and suggest corrections
    const typoCheck = run({email});
    if (typoCheck && typoCheck.address && typoCheck.address !== email) {
      result.suggestedEmail = typoCheck.full;
      result.reasons.push(`Possible typo detected, did you mean ${typoCheck.domain}?`);
      result.isTypo = true;
    }

    // Step 1: Check NS records - proves the domain exists in DNS
    try {
      const nsRecords = await dns.resolveNs(domain);
      result.domainExists = nsRecords && nsRecords.length > 0;
    } catch {
      result.domainExists = false;
      result.valid = false;
      result.reasons.push('Domain does not exist (no nameservers found)');
      // If domain doesn't exist, no point checking MX/A records
      return result;
    }

    // Step 2: Check MX records - required for receiving email
    try {
      const mxRecords = await dns.resolveMx(domain);
      result.hasMxRecords = mxRecords && mxRecords.length > 0;
      if (!result.hasMxRecords) {
        result.valid = false;
        result.reasons.push('Domain cannot receive email (no MX records found)');
      }
    } catch {
      result.hasMxRecords = false;
      result.valid = false;
      result.reasons.push('Domain cannot receive email (no MX records found)');
    }

    // Step 3: Check if domain has A/AAAA records - informational only
    // This indicates if the domain has a website/web server
    // Doesn't affect email validity since email only requires MX records
    try {
      await dns.resolve(domain, 'A');
      result.hasWebsite = true;
    } catch {
      // Try AAAA records if A records fail
      try {
        await dns.resolve(domain, 'AAAA');
        result.hasWebsite = true;
      } catch {
        // Domain doesn't have A/AAAA records (no website), but this is OK for email
        result.hasWebsite = false;
      }
    }

    // If no issues were found, add a success reason
    if (result.valid && result.reasons.length === 0) {
      result.reasons.push('Email appears to be valid');
    }

    return result;
  }

  /**
   * Fetch and cache the disposable domains list from GitHub
   * Uses Redis for caching with 24-hour TTL
   * Falls back to in-memory cache if Redis fails
   */
  private static async getDisposableDomains(): Promise<Set<string>> {
    // Return in-memory cache if available
    if (this.disposableDomainsSet) {
      return this.disposableDomainsSet;
    }
    // Plunk Lite: requests that arrive while the list is downloading wait for that download
    this.disposableDomainsLoading ??= this.loadDisposableDomains().finally(() => {
      this.disposableDomainsLoading = null;
    });
    return this.disposableDomainsLoading;
  }

  private static async loadDisposableDomains(): Promise<Set<string>> {
    // Plunk Lite: after a failed download, go without the list for a while rather than retry
    // on every request
    if (this.disposableDomainsFailedAt !== null && Date.now() - this.disposableDomainsFailedAt < LIST_RETRY_AFTER_MS) {
      return new Set<string>();
    }

    try {
      // Try to get from Redis cache first (Plunk Lite: only while connected, as it would wait)
      const cached = redisReady() ? await redis.get(DISPOSABLE_DOMAINS_CACHE_KEY) : null;
      if (cached) {
        const domains = JSON.parse(cached) as string[];
        this.disposableDomainsSet = new Set(domains);
        return this.disposableDomainsSet;
      }

      // Fetch from GitHub if not in cache
      const response = await fetch(DISPOSABLE_DOMAINS_URL, {signal: AbortSignal.timeout(LIST_DOWNLOAD_TIMEOUT_MS)});
      if (!response.ok) {
        throw new Error(`Failed to fetch disposable domains: ${response.statusText}`);
      }

      const text = await response.text();
      const domains = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')); // Filter empty lines and comments

      // Cache in memory, then in Redis (Plunk Lite: in this order, so a Redis error keeps the list)
      this.disposableDomainsSet = new Set(domains);
      if (redisReady()) {
        await redis.set(DISPOSABLE_DOMAINS_CACHE_KEY, JSON.stringify(domains), 'EX', CACHE_TTL_SECONDS);
      }
      return this.disposableDomainsSet;
    } catch (error) {
      if (this.disposableDomainsSet) {
        return this.disposableDomainsSet;
      }
      this.disposableDomainsFailedAt = Date.now();
      console.error('Error fetching disposable domains:', error);
      // Return empty set as fallback - don't block email verification
      return new Set<string>();
    }
  }

  /**
   * Check if a domain is disposable
   */
  private static async isDisposableDomain(domain: string): Promise<boolean> {
    const disposableDomains = await this.getDisposableDomains();
    return disposableDomains.has(domain.toLowerCase());
  }

  /**
   * Check if a domain is a known forwarding/alias service
   */
  private static isForwardingDomain(domain: string): boolean {
    return FORWARDING_DOMAINS.has(domain.toLowerCase());
  }

  /**
   * Fetch and cache the personal email domains list from GitHub
   * Uses Redis for caching with 24-hour TTL
   * Falls back to in-memory cache if Redis fails
   */
  private static async getPersonalEmailDomains(): Promise<Set<string>> {
    // Return in-memory cache if available
    if (this.personalDomainsSet) {
      return this.personalDomainsSet;
    }

    try {
      // Try to get from Redis cache first
      const cached = await redis.get(PERSONAL_DOMAINS_CACHE_KEY);
      if (cached) {
        const domains = JSON.parse(cached) as string[];
        this.personalDomainsSet = new Set(domains);
        return this.personalDomainsSet;
      }

      // Fetch from GitHub if not in cache
      const response = await fetch(PERSONAL_DOMAINS_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch personal email domains: ${response.statusText}`);
      }

      const text = await response.text();
      const domains = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')); // Filter empty lines and comments

      // Cache in Redis
      await redis.set(PERSONAL_DOMAINS_CACHE_KEY, JSON.stringify(domains), 'EX', CACHE_TTL_SECONDS);

      // Cache in memory
      this.personalDomainsSet = new Set(domains);
      return this.personalDomainsSet;
    } catch (error) {
      console.error('Error fetching personal email domains:', error);
      // Return empty set as fallback - don't block email verification
      return new Set<string>();
    }
  }

  /**
   * Check if a domain is a personal/free email provider
   */
  private static async isPersonalEmailDomain(domain: string): Promise<boolean> {
    const personalDomains = await this.getPersonalEmailDomains();
    return personalDomains.has(domain.toLowerCase());
  }
}
