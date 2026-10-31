/** Plunk Lite: how a webhook step's request is delivered and retried, and how its failures read */

/** Delays before each automatic retry of a request that failed for a reason that may pass */
export const WEBHOOK_RETRY_DELAYS_MS = [3_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/** Longest a webhook request may take, each redirect on its own */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The header naming a delivery: the same on every attempt, for a receiver to drop repeats */
export const WEBHOOK_DELIVERY_HEADER = 'X-Plunk-Delivery-Id';

/** A request that failed for a reason that may pass, and is worth repeating */
export class WebhookTransientError extends Error {}

/** A connection that dropped or never opened, or an answer cut short */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTCONN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);

const DNS_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND']);

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

interface NetworkFailure {
  code: string;
  address?: string;
  port?: number;
}

/** Each failed connection behind an error, through its causes and an AggregateError's attempts */
function failuresOf(error: unknown): NetworkFailure[] {
  if (typeof error !== 'object' || error === null) {
    return [];
  }
  const {code, address, port, cause} = error as {code?: unknown; address?: unknown; port?: unknown; cause?: unknown};
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.flatMap(failuresOf);
  }
  if (typeof code === 'string') {
    return [
      {
        code,
        address: typeof address === 'string' ? address : undefined,
        port: typeof port === 'number' ? port : undefined,
      },
    ];
  }
  return failuresOf(cause);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function describeFailure({code, address, port}: NetworkFailure): string {
  if (!address) {
    return code;
  }
  const host = address.includes(':') ? `[${address}]` : address;
  return `${code} ${host}${port === undefined ? '' : `:${port}`}`;
}

/**
 * An HTTP status worth repeating the request for: the receiver is out or busy. Any other answer
 * would be the same again.
 */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || TRANSIENT_STATUSES.has(status);
}

/**
 * Whether a failed request may work later. Not ENOTFOUND: the host does not exist, most likely a
 * typo, which should be told right away. Nor any other error fetch throws, such as a URL with
 * credentials or an invalid header, which would fail the same forever.
 */
export function isTransientNetworkError(error: unknown): boolean {
  return isTimeout(error) || failuresOf(error).some(({code}) => TRANSIENT_CODES.has(code));
}

/**
 * What went wrong with a request, by host only. This text is stored and sent in alerts, and a
 * webhook's URL can carry a token in its path or credentials. So never fetch's own message, which
 * may quote the URL or a header.
 */
export function describeNetworkError(error: unknown, hostname: string): string {
  if (isTimeout(error)) {
    return `Timed out after ${WEBHOOK_TIMEOUT_MS / 1000} s waiting for ${hostname}`;
  }
  const failures = failuresOf(error);
  if (failures.length === 0) {
    return `Request to ${hostname} failed (${error instanceof Error ? error.name : 'unknown error'})`;
  }
  const first = failures[0]!.code;
  const detail = failures.map(describeFailure).join(', ');
  if (DNS_CODES.has(first)) {
    return `DNS lookup failed for ${hostname}: ${detail}`;
  }
  return `Connection to ${hostname} failed: ${detail}`;
}

/** The error a failed request is reported as: transient or not, and saying only what is safe to store */
export function toDeliveryError(error: unknown, hostname: string): Error {
  const message = describeNetworkError(error, hostname);
  return isTransientNetworkError(error) ? new WebhookTransientError(message) : new Error(message);
}
