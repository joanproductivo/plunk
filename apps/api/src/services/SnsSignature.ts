import crypto from 'crypto';

import signale from 'signale';

// SNS in an AWS region (`sns.eu-north-1.amazonaws.com`, GovCloud, China): nothing else is fetched
const SNS_CERT_HOST_RE = /^sns\.[a-z]{2}(-gov)?-[a-z]+-\d\.amazonaws\.com(\.cn)?$/;
// The only shape AWS publishes its signing certificates under
const SNS_CERT_PATH_RE = /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;
// AWS rotates its signing certificate now and then, so a handful covers every region a
// topic can live in; past this, the oldest one fetched goes first
const CERT_CACHE_MAX = 20;
const signingCertCache = new Map<string, string>();
// URLs whose certificate does not exist (a 4xx, a host that is not there), not asked for again for a
// while: a forged message can name any of them, once per path. Bounded like the certificates.
const MISSING_CERT_MS = 5 * 60 * 1000;
const MISSING_CERT_MAX = 200;
const missingCertCache = new Map<string, number>();

/** The outcome of checking an SNS message signature */
export type SnsSignatureCheck = 'valid' | 'invalid' | 'unavailable';

/** AWS's signing certificate could not be fetched: the network failed, or SNS answered with a 5xx */
class SigningCertUnavailableError extends Error {}

/** Whether a failed fetch says the host does not exist (DNS answered NXDOMAIN) */
function isMissingHost(error: unknown): boolean {
  for (let cause = error; cause && typeof cause === 'object'; cause = (cause as {cause?: unknown}).cause) {
    if ((cause as {code?: unknown}).code === 'ENOTFOUND') {
      return true;
    }
  }
  return false;
}

/** A certificate URL that answered it has no certificate: invalid, and remembered for a while */
function missingCert(key: string, reason: string): Error {
  missingCertCache.delete(key);
  if (missingCertCache.size >= MISSING_CERT_MAX) {
    missingCertCache.delete(missingCertCache.keys().next().value!);
  }
  missingCertCache.set(key, Date.now() + MISSING_CERT_MS);
  return new Error(`Failed to fetch SNS signing cert: ${reason}`);
}

/**
 * The certificate URL as a cache key, or null when it is not one AWS would sign with: an https
 * URL on an SNS host, at the path of a `.pem`, and nothing else. Checked before anything is
 * fetched, so a forged message cannot make this server request other URLs or fill the cache with
 * one entry per query string.
 */
function signingCertKey(certUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return null;
  }

  const trusted =
    url.protocol === 'https:' &&
    SNS_CERT_HOST_RE.test(url.hostname) &&
    SNS_CERT_PATH_RE.test(url.pathname) &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !url.port;
  return trusted ? url.origin + url.pathname : null;
}

async function fetchSigningCert(key: string): Promise<string> {
  const cached = signingCertCache.get(key);
  if (cached) return cached;
  const missingUntil = missingCertCache.get(key);
  if (missingUntil !== undefined) {
    if (missingUntil > Date.now()) throw new Error('SNS signing cert known to be missing');
    missingCertCache.delete(key);
  }

  // Anything that keeps an answer from arriving -- the network, the timeout (which runs from
  // the request to the last byte of the body), a 5xx -- is unavailable. A 4xx is an answer: the
  // certificate does not exist, so the signature cannot be valid. So is a host DNS says does not
  // exist, a region that is not one.
  const signal = AbortSignal.timeout(5000);
  let response: Response;
  try {
    response = await fetch(key, {signal});
  } catch (error) {
    if (isMissingHost(error)) throw missingCert(key, 'no such host');
    throw new SigningCertUnavailableError(`Failed to fetch SNS signing cert: ${String(error)}`);
  }
  if (response.status >= 500) {
    throw new SigningCertUnavailableError(`Failed to fetch SNS signing cert: ${response.status}`);
  }
  if (!response.ok) throw missingCert(key, `${response.status} ${response.statusText}`);

  let pem: string;
  try {
    pem = await response.text();
  } catch (error) {
    throw new SigningCertUnavailableError(`Failed to read SNS signing cert: ${String(error)}`);
  }

  if (signingCertCache.size >= CERT_CACHE_MAX) {
    // A Map iterates in insertion order, so its first key is the oldest certificate
    signingCertCache.delete(signingCertCache.keys().next().value!);
  }
  signingCertCache.set(key, pem);
  return pem;
}

function buildSnsStringToSign(message: Record<string, string>): string {
  const fields =
    message['Type'] === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  return fields
    .filter(key => message[key] !== undefined)
    .map(key => `${key}\n${message[key]}\n`)
    .join('');
}

/** The signature AWS puts on every SNS message the webhook receives */
export class SnsSignature {
  /**
   * Verify an AWS SNS message signature: 'invalid' if the cert URL is untrusted or the
   * signature doesn't match, 'unavailable' if AWS's certificate could not be fetched.
   */
  public static async verify(body: Record<string, string>): Promise<SnsSignatureCheck> {
    try {
      const certUrl = body['SigningCertURL'];
      const signature = body['Signature'];

      if (!certUrl || !signature) {
        signale.warn('[SNS] Missing SigningCertURL or Signature');
        return 'invalid';
      }

      const key = signingCertKey(certUrl);
      if (!key) {
        signale.warn(`[SNS] Untrusted SigningCertURL: ${certUrl.slice(0, 200)}`);
        return 'invalid';
      }

      const pem = await fetchSigningCert(key);
      const stringToSign = buildSnsStringToSign(body);
      const algorithm = body['SignatureVersion'] === '2' ? 'RSA-SHA256' : 'RSA-SHA1';

      const verifier = crypto.createVerify(algorithm);
      verifier.update(stringToSign, 'utf8');
      return verifier.verify(pem, signature, 'base64') ? 'valid' : 'invalid';
    } catch (err) {
      signale.error('[SNS] Signature verification error:', err);
      return err instanceof SigningCertUnavailableError ? 'unavailable' : 'invalid';
    }
  }
}
