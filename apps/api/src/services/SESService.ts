import type {EventType} from '@aws-sdk/client-ses';
import {SES} from '@aws-sdk/client-ses';
import {SESv2} from '@aws-sdk/client-sesv2';
import {STS} from '@aws-sdk/client-sts';
import signale from 'signale';

import {
  AWS_SES_ACCESS_KEY_ID,
  AWS_SES_REGION,
  AWS_SES_SECRET_ACCESS_KEY,
  MAIL_FROM_SUBDOMAIN,
  SES_CONFIGURATION_SET,
  SES_CONFIGURATION_SET_NO_TRACKING,
  TRACKING_TOGGLE_ENABLED,
} from '../app/constants.js';
import {
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatFilenameParameter,
  formatMailbox,
  htmlToPlainText,
} from '../utils/mime.js';

const SES_CLIENT_CONFIG = {
  apiVersion: '2010-12-01',
  region: AWS_SES_REGION,
  credentials: {
    accessKeyId: AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: AWS_SES_SECRET_ACCESS_KEY,
  },
};

/**
 * Timeouts for every SES request. The SDK sets none by default, and without
 * `throwOnRequestTimeout` a request past its `requestTimeout` only logs a warning, so a hung
 * connection held a worker slot for good. The request timeout stays under the worker's
 * shutdown timeout, so a send cut short by a deploy is settled before the process exits.
 */
const SES_HTTP_OPTIONS = {connectionTimeout: 5_000, requestTimeout: 15_000, throwOnRequestTimeout: true};

/** Ceiling on a whole send, under the worker's shutdown timeout like the request timeout */
const SEND_TIMEOUT_MS = 20_000;

/**
 * AWS SES Client for everything but sending: domain, DKIM and quota calls are safe to repeat,
 * so they keep the SDK's own retries
 */
export const ses = new SES({...SES_CLIENT_CONFIG, requestHandler: SES_HTTP_OPTIONS});

/**
 * AWS SES Client for sending. One attempt, without keep-alive: the SDK retries a reset or a
 * timeout on its own, and after SES has accepted an email that delivers it again. A socket kept
 * alive that SES has closed fails with the same reset as a connection lost after sending, so
 * fresh connections keep that ambiguity out. Whether a failed send is retried is decided by the
 * caller, with `safeToRetrySend`.
 */
const sesSend = new SES({
  ...SES_CLIENT_CONFIG,
  maxAttempts: 1,
  requestHandler: {...SES_HTTP_OPTIONS, httpsAgent: {keepAlive: false}},
});

/** Node's codes for a connection that was never made, so nothing reached SES */
const NEVER_CONNECTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** The system calls that fail before a socket is connected: DNS and the TCP connect itself */
const NEVER_CONNECTED_SYSCALLS = new Set(['connect', 'getaddrinfo']);

/**
 * Whether a failed send can be retried without risking a second copy: SES answered and refused
 * it (an HTTP error status), or the connection was never made. Anything else -- a reset or a
 * timeout after the request went out, or a 2xx whose body could not be read, which the SDK
 * reports with the 2xx status -- may follow an email SES accepted.
 */
export function safeToRetrySend(error: unknown): boolean {
  const failure = error as {
    $metadata?: {httpStatusCode?: unknown};
    code?: unknown;
    syscall?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = failure?.$metadata?.httpStatusCode;

  if (typeof status === 'number') {
    return status >= 400;
  }

  if (typeof failure?.code === 'string' && NEVER_CONNECTED_CODES.has(failure.code)) {
    return true;
  }

  // Any failure of the connect itself -- an unreachable host or network, a connect timeout
  if (typeof failure?.syscall === 'string' && NEVER_CONNECTED_SYSCALLS.has(failure.syscall)) {
    return true;
  }

  // The connection timeout fires only before the socket connects
  return (
    failure?.name === 'TimeoutError' &&
    typeof failure.message === 'string' &&
    failure.message.includes('did not establish a connection')
  );
}

/** Plunk Lite: what a refusal from SES calls for */
type SesRefusal = 'rate' | 'daily-quota' | 'account-paused' | 'config-set' | 'rejected' | 'other';

/**
 * How SES words a pause of the whole account. A pause AWS imposes for reputation may come as a
 * MessageRejected with this text rather than as AccountSendingPausedException; never matches a
 * sandbox's "Email address is not verified".
 */
const ACCOUNT_PAUSED_MESSAGE = /account is paused|sending paused|sending is paused|sending suspended/i;

/** Refusals about the email itself or its sender, which a retry would only repeat */
const REJECTED_NAMES = new Set([
  'MessageRejected',
  'InvalidParameterValue',
  'MailFromDomainNotVerifiedException',
  'FromEmailAddressNotVerifiedException',
]);

/**
 * Plunk Lite: sort an error SES answered a send with. Only an answer from SES (an HTTP error status)
 * is sorted; anything else is 'other', as is any refusal not known here, which keeps today's
 * retries. `mainConfigurationSet` says whether the email went through SES_CONFIGURATION_SET: a
 * pause of that one stops every send, a pause or loss of the no-tracking one only its emails.
 */
export function classifySesRefusal(
  error: unknown,
  {mainConfigurationSet}: {mainConfigurationSet: boolean},
): SesRefusal {
  const failure = error as {$metadata?: {httpStatusCode?: unknown}; name?: unknown; message?: unknown};
  const status = failure?.$metadata?.httpStatusCode;
  if (typeof status !== 'number' || status < 400) {
    return 'other';
  }
  const name = typeof failure.name === 'string' ? failure.name : '';
  const message = typeof failure.message === 'string' ? failure.message : '';

  if (name === 'Throttling' || name === 'ThrottlingException') {
    return /daily message quota/i.test(message) ? 'daily-quota' : 'rate';
  }
  // By name first: a configuration set's pause is worded like the account's
  if (name === 'ConfigurationSetSendingPausedException') {
    return mainConfigurationSet ? 'account-paused' : 'config-set';
  }
  if (name === 'ConfigurationSetDoesNotExistException') {
    return 'config-set';
  }
  if (name === 'AccountSendingPausedException' || ACCOUNT_PAUSED_MESSAGE.test(message)) {
    return 'account-paused';
  }
  return REJECTED_NAMES.has(name) ? 'rejected' : 'other';
}

/** The configuration set an email goes through: the no-tracking one only for an untracked email */
export function configurationSetFor(tracking: boolean): string | undefined {
  return TRACKING_TOGGLE_ENABLED && !tracking ? SES_CONFIGURATION_SET_NO_TRACKING : SES_CONFIGURATION_SET;
}

/**
 * AWS STS Client, used only to look up the account the SES credentials belong to
 */
const sts = new STS({
  region: AWS_SES_REGION,
  credentials: {
    accessKeyId: AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: AWS_SES_SECRET_ACCESS_KEY,
  },
});

let awsAccountId: Promise<string> | undefined;

/**
 * The AWS account the SES credentials belong to. GetCallerIdentity needs no IAM
 * permission, so this works with any policy. Looked up once and cached; a failed
 * lookup is not cached, so the next call tries again.
 */
export const getAwsAccountId = (): Promise<string> => {
  awsAccountId ??= sts
    .getCallerIdentity({})
    .then(identity => {
      if (!identity.Account) {
        throw new Error('GetCallerIdentity returned no account');
      }
      return identity.Account;
    })
    .catch((error: unknown) => {
      awsAccountId = undefined;
      throw error;
    });

  return awsAccountId;
};

/**
 * Plunk Lite: the SES message tags each email is sent with. SES repeats them in every event it
 * publishes for the email (`mail.tags`), so the webhook can tell which email and project an event
 * is about even when the email's messageId was never stored.
 */
export const SES_TAG = {emailId: 'plunk_email_id', projectId: 'plunk_project_id', kind: 'plunk_kind'} as const;

/** What an email sent through SES is: one of the project's emails, a campaign's test send, or an alert */
export interface SesMessageTags {
  emailId?: string;
  projectId: string;
  kind: 'email' | 'test' | 'alert';
}

/** The tags as SES takes them, which allows only letters, digits, `_` and `-` in a value */
function toSesTags(tags: SesMessageTags): {Name: string; Value: string}[] {
  const values: [string, string | undefined][] = [
    [SES_TAG.emailId, tags.emailId],
    [SES_TAG.projectId, tags.projectId],
    [SES_TAG.kind, tags.kind],
  ];
  return values
    .filter((tag): tag is [string, string] => Boolean(tag[1]))
    .map(([Name, Value]) => ({Name, Value: Value.replace(/[^A-Za-z0-9_-]/g, '_')}));
}

interface SendRawEmailParams {
  from: {
    name: string;
    email: string;
  };
  to: string[] | {name?: string; email: string}[];
  content: {
    subject: string;
    html: string;
    /**
     * Plain-text alternative. Derived from `html` when omitted, which is the normal
     * path — this exists so a caller that already has a hand-written text version can
     * supply it instead of taking the conversion.
     */
    text?: string;
  };
  reply?: string;
  headers?: Record<string, string> | null;
  attachments?:
    | {
        filename: string;
        content: string; // Base64 encoded
        contentType: string;
        contentId?: string;
        disposition?: 'attachment' | 'inline';
      }[]
    | null;
  tracking?: boolean;
  tags?: SesMessageTags;
}

/**
 * Break base64 content into fixed-width lines to comply with RFC 5322's line limit.
 *
 * Base64 is a fixed alphabet with no significant whitespace, so it can be split at any
 * offset. Text and HTML parts do not go through here — they are quoted-printable
 * encoded, which breaks lines with soft breaks the recipient's client removes.
 */
function breakLongLines(input: string, maxLineLength: number): string {
  const result = [];
  for (let i = 0; i < input.length; i += maxLineLength) {
    result.push(input.substring(i, i + maxLineLength));
  }
  return result.join('\n');
}

/**
 * Send a raw email via AWS SES with full MIME formatting
 */
export async function sendRawEmail({
  from,
  to,
  content,
  reply,
  headers,
  attachments,
  tracking = true,
  tags,
}: SendRawEmailParams): Promise<{messageId: string}> {
  // Generate unique boundaries for multipart messages
  const altBoundary = `----=_AltPart_${Math.random().toString(36).substring(2)}`;
  const mixedBoundary = attachments?.some(a => (a.disposition ?? 'attachment') === 'attachment')
    ? `----=_MixedPart_${Math.random().toString(36).substring(2)}`
    : null;
  const relatedBoundary = attachments?.some(a => a.disposition === 'inline')
    ? `----=_RelatedPart_${Math.random().toString(36).substring(2)}`
    : null;

  // Format To header with names if provided
  const toHeader = to
    .map(recipient => (typeof recipient === 'string' ? recipient : formatMailbox(recipient.name, recipient.email)))
    .join(',\n ');

  // Extract just email addresses for Destinations (SES requirement)
  const destinations = to.map(recipient => (typeof recipient === 'string' ? recipient : recipient.email));

  // Determine root content type
  let rootContentType = `multipart/alternative; boundary="${altBoundary}"`;
  if (mixedBoundary) {
    rootContentType = `multipart/mixed; boundary="${mixedBoundary}"`;
  } else if (relatedBoundary) {
    rootContentType = `multipart/related; boundary="${relatedBoundary}"`;
  }

  // Serialize the caller-provided headers (built by buildEmailHeaders), filtering
  // out empties so we never emit a blank line inside the header section.
  // Per RFC 5322 §2.1, a blank line terminates the header section, so any blank
  // line here would push subsequent headers (notably List-Unsubscribe) into the body.
  const extraHeaderLines = headers ? Object.entries(headers).map(([key, value]) => `${key}: ${value}`) : [];
  const extraHeaders = extraHeaderLines.length > 0 ? `\n${extraHeaderLines.join('\n')}` : '';

  // Build raw MIME message
  let rawMessage = `From: ${formatMailbox(from.name, from.email)}
To: ${toHeader}
Reply-To: ${reply || from.email}
Subject: ${encodeHeaderValue(content.subject, 'Subject: '.length)}
MIME-Version: 1.0
Content-Type: ${rootContentType}${extraHeaders}

`;

  // building the body
  if (mixedBoundary) {
    rawMessage += `--${mixedBoundary}\n`;
    if (relatedBoundary) {
      rawMessage += `Content-Type: multipart/related; boundary="${relatedBoundary}"\n\n`;
      rawMessage += `--${relatedBoundary}\n`;
    }
  } else if (relatedBoundary) {
    rawMessage += `--${relatedBoundary}\n`;
  }

  // If we are nested, we need to specify that this next part is the alternative container
  if (mixedBoundary || relatedBoundary) {
    rawMessage += `Content-Type: multipart/alternative; boundary="${altBoundary}"\n\n`;
  }

  // The plain-text alternative comes first: `multipart/alternative` is ordered
  // least-rich to most-rich (RFC 2046 §5.1.4), and clients render the last part they
  // can display. Emitting these the other way round would show plain text to everyone.
  //
  // Skipped entirely when the conversion yields nothing (an image-only email, say).
  // An empty text part is worse than no text part: it is the exact shape of the
  // filter-evasion message the spam rules are looking for.
  const plainText = content.text ?? htmlToPlainText(content.html);
  if (plainText.trim().length > 0) {
    rawMessage += `--${altBoundary}
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

${encodeQuotedPrintable(plainText)}
`;
  }

  // The alternative part content (always contains HTML)
  rawMessage += `--${altBoundary}
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

${encodeQuotedPrintable(content.html)}
--${altBoundary}--
`;

  // Add inline attachments to the related container
  if (relatedBoundary) {
    const inlineAttachments = attachments?.filter(a => a.disposition === 'inline') ?? [];
    for (const attachment of inlineAttachments) {
      rawMessage += `\n--${relatedBoundary}
Content-Type: ${attachment.contentType}
Content-Transfer-Encoding: base64
Content-ID: <${attachment.contentId || attachment.filename}>
Content-Disposition: inline;
 ${formatFilenameParameter(attachment.filename)}

${breakLongLines(attachment.content, 76)}`;
    }
    rawMessage += `\n--${relatedBoundary}--`;
  }

  // Add regular attachments to the mixed container
  if (mixedBoundary) {
    const regularAttachments = attachments?.filter(a => (a.disposition ?? 'attachment') === 'attachment') ?? [];
    for (const attachment of regularAttachments) {
      rawMessage += `\n--${mixedBoundary}
Content-Type: ${attachment.contentType}
Content-Transfer-Encoding: base64
Content-Disposition: attachment;
 ${formatFilenameParameter(attachment.filename)}

${breakLongLines(attachment.content, 76)}`;
    }
    rawMessage += `\n--${mixedBoundary}--`;
  }

  // Determine which configuration set to use
  // Only use NO_TRACKING if tracking toggle is enabled AND tracking is disabled
  const configurationSetName = configurationSetFor(tracking);

  // Send via SES
  const response = await sesSend.sendRawEmail(
    {
      Destinations: destinations,
      ConfigurationSetName: configurationSetName,
      RawMessage: {
        Data: new TextEncoder().encode(rawMessage),
      },
      // The address alone: the display name travels in the From header above, and Source
      // only names the sending identity and where bounces go.
      Source: from.email,
      ...(tags && {Tags: toSesTags(tags)}),
    },
    // The request timeout stops once SES's answer starts arriving; this bounds the whole send,
    // the answer's body included. An abort mid-answer reports no error status, so it is failed
    // as possibly sent, never retried.
    {abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS)},
  );

  if (!response.MessageId) {
    throw new Error('Could not send email');
  }

  return {messageId: response.MessageId};
}

/**
 * Get verification attributes for multiple domain identities
 */
export const getIdentities = async (domains: string[]): Promise<{domain: string; status: string}[]> => {
  const res = await ses.getIdentityVerificationAttributes({
    Identities: domains,
  });

  const parsedResult = Object.entries(res.VerificationAttributes ?? {});
  return parsedResult.map(obj => {
    return {domain: obj[0], status: obj[1].VerificationStatus ?? 'NotStarted'};
  });
};

/**
 * Verify a domain and get DKIM tokens for DNS configuration
 */
export const verifyDomain = async (domain: string): Promise<string[]> => {
  // Verify DKIM for the domain
  const DKIM = await ses.verifyDomainDkim({Domain: domain});

  // Set custom MAIL FROM domain. The subdomain defaults to `plunk` and can be
  // overridden via the MAIL_FROM_SUBDOMAIN env var — useful when `plunk.<domain>`
  // is already in use for something else (e.g., a CNAME to a CDN), since the
  // MAIL FROM subdomain needs MX + TXT records that conflict with a CNAME.
  await ses.setIdentityMailFromDomain({
    Identity: domain,
    MailFromDomain: `${MAIL_FROM_SUBDOMAIN}.${domain}`,
  });

  return DKIM.DkimTokens ?? [];
};

/**
 * Get DKIM verification attributes for a domain
 */
export const getDomainVerificationAttributes = async (domain: string) => {
  const attributes = await ses.getIdentityDkimAttributes({
    Identities: [domain],
  });

  const parsedAttributes = Object.entries(attributes.DkimAttributes ?? {});

  if (parsedAttributes.length === 0) {
    return {
      domain,
      tokens: [],
      status: 'NotStarted',
    };
  }

  const firstAttribute = parsedAttributes[0];
  if (!firstAttribute) {
    return {
      domain,
      tokens: [],
      status: 'NotStarted',
    };
  }

  return {
    domain: firstAttribute[0],
    tokens: firstAttribute[1].DkimTokens ?? [],
    status: firstAttribute[1].DkimVerificationStatus ?? 'NotStarted',
  };
};

/**
 * Disable bounce/complaint forwarding for a verified domain
 */
export const disableFeedbackForwarding = async (domain: string): Promise<void> => {
  await ses.setIdentityFeedbackForwardingEnabled({
    Identity: domain,
    ForwardingEnabled: false,
  });
};

/**
 * Delete a verified domain identity from AWS SES
 */
export const deleteIdentity = async (domain: string): Promise<void> => {
  await ses.deleteIdentity({Identity: domain});
};

/**
 * The SES events the webhook needs from a configuration set: without bounces and complaints no
 * address is ever suppressed, and without deliveries the check of the event pipeline reads every
 * email as lost (Plunk Lite)
 */
const REQUIRED_EVENT_TYPES: EventType[] = ['bounce', 'complaint', 'delivery'];

/**
 * Check at startup that the configuration sets Plunk sends through exist in SES and publish the
 * events the webhook needs to an SNS topic (Plunk Lite). A missing set otherwise only shows up as a
 * failed send, with an AWS error that doesn't name the env var, and a set without its SNS
 * destination never shows up at all. The no-tracking set is only checked when it was configured
 * explicitly, since that is the only case in which it is used.
 *
 * Returns what is wrong, one sentence per set; undefined when SES could not be asked. Never throws:
 * a failed check is logged and the API keeps starting.
 */
export const verifyConfigurationSets = async (): Promise<string[] | undefined> => {
  const sets: {envVar: string; name: string}[] = [{envVar: 'SES_CONFIGURATION_SET', name: SES_CONFIGURATION_SET}];
  if (TRACKING_TOGGLE_ENABLED) {
    sets.push({envVar: 'SES_CONFIGURATION_SET_NO_TRACKING', name: SES_CONFIGURATION_SET_NO_TRACKING});
  }

  const problems: string[] = [];
  for (const {envVar, name} of sets) {
    try {
      const {EventDestinations: destinations = []} = await ses.describeConfigurationSet({
        ConfigurationSetName: name,
        ConfigurationSetAttributeNames: ['eventDestinations'],
      });
      const publishing = destinations.some(
        destination =>
          destination.Enabled &&
          destination.SNSDestination?.TopicARN &&
          REQUIRED_EVENT_TYPES.every(type => destination.MatchingEventTypes?.includes(type)),
      );
      if (!publishing) {
        problems.push(
          `Configuration set "${name}" from ${envVar} has no enabled SNS event destination publishing ${REQUIRED_EVENT_TYPES.join(', ')} events: no bounce or complaint of its emails reaches Plunk.`,
        );
      }
    } catch (error) {
      const errorName = error instanceof Error ? error.name : undefined;

      if (errorName === 'ConfigurationSetDoesNotExistException') {
        problems.push(
          `Configuration set "${name}" from ${envVar} does not exist in ${AWS_SES_REGION}: emails sent through it fail until it is created or ${envVar} is corrected.`,
        );
      } else if (errorName === 'AccessDenied' || errorName === 'AccessDeniedException') {
        // Older IAM policies predate this check, so a missing permission is not a misconfiguration
        signale.info('[SES] Skipped configuration set check: grant ses:DescribeConfigurationSet to enable it');
        return undefined;
      } else {
        signale.warn(`[SES] Could not verify configuration set "${name}" from ${envVar}:`, error);
        return undefined;
      }
    }
  }

  for (const problem of problems) {
    signale.error(`[SES] ${problem}`);
  }
  return problems;
};

/**
 * Plunk Lite: the account's 24-hour quota and what it has sent, for a campaign about to start: at
 * most 3 seconds, without the SDK's retries, and null when SES does not answer or leaves a figure out
 * (rather than the sandbox's figure getSendingQuota assumes). A negative maximum means no limit.
 */
export async function getDailyQuotaQuick(): Promise<{max24HourSend: number; sentLast24Hours: number} | null> {
  try {
    const quota = await ses.getSendQuota({}, {abortSignal: AbortSignal.timeout(3000)});
    if (quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) {
      return null;
    }
    return {max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours};
  } catch (error) {
    signale.warn(
      `[SES] Could not read the sending quota before a campaign: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}

/**
 * Plunk Lite: SES API v2, only to read the account's status. One attempt, like the send client: the
 * question is asked again soon enough.
 */
const sesv2 = new SESv2({
  region: AWS_SES_REGION,
  credentials: SES_CLIENT_CONFIG.credentials,
  maxAttempts: 1,
  requestHandler: SES_HTTP_OPTIONS,
});

/**
 * Plunk Lite: whether the account is paused, from GetAccount (SES API v2): 'paused' when SES has
 * paused it (EnforcementStatus SHUTDOWN) or its sending is switched off, 'ok' otherwise. At most
 * 2 seconds; null when it gives no answer -- the IAM policy lacks ses:GetAccount, or SES does not
 * answer. GetAccountSendingEnabled would not do: it does not change when SES pauses the account.
 */
export async function getAccountStatusQuick(): Promise<'paused' | 'ok' | null> {
  try {
    const account = await sesv2.getAccount({}, {abortSignal: AbortSignal.timeout(2000)});
    return account.EnforcementStatus === 'SHUTDOWN' || account.SendingEnabled === false ? 'paused' : 'ok';
  } catch (error) {
    signale.warn(`[SES] Could not read the account's status: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Get AWS SES account sending quota and rate limit
 * @returns MaxSendRate (emails per second) or null if the call fails
 */
export const getSendingQuota = async (): Promise<{
  maxSendRate: number;
  max24HourSend: number;
  sentLast24Hours: number;
} | null> => {
  try {
    const quota = await ses.getSendQuota({});

    return {
      maxSendRate: quota.MaxSendRate ?? 14, // Default to sandbox limit if not provided
      max24HourSend: quota.Max24HourSend ?? 200, // Default sandbox daily limit
      sentLast24Hours: quota.SentLast24Hours ?? 0,
    };
  } catch (error) {
    signale.error('[SES] Failed to fetch sending quota:', error);
    return null;
  }
};
