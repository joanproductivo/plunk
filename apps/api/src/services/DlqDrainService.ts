import {type Message, SQS} from '@aws-sdk/client-sqs';
import signale from 'signale';

import {AWS_SES_REGION} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redisReady} from '../database/redis.js';
import {HandlerTimedOut, invokeHandler} from '../utils/invokeHandler.js';

import {
  DLQ_ACCESS_SOURCE,
  DLQ_ALARM_SOURCE,
  DLQ_INVALID_SOURCE,
  DLQ_NAME,
  DLQ_REPLAY,
  DLQ_SUMMARY_SOURCE,
} from './dlqConstants.js';
import {FailureAlertService} from './FailureAlertService.js';
import {parseSnsMessage, readSesNotification, sesTags} from './SesEventMatch.js';
import {AWS_CLIENT_CONFIG, getAwsAccountId, SES_HTTP_OPTIONS} from './SESService.js';
import {SnsMessages} from './SnsMessages.js';

/**
 * Plunk Lite: what SNS could not deliver to the webhook, taken back from the dead-letter queue of
 * SES events (`DLQ_NAME`) and handled by the webhook itself, inside the worker. The queue is checked
 * with the SES events check every 15 minutes and drained when the alarm on it fires or someone asks;
 * a drain stops once the queue is empty.
 */

const sqs = new SQS({...AWS_CLIENT_CONFIG, requestHandler: SES_HTTP_OPTIONS});

/** Messages read at once, SQS's maximum */
const BATCH = 10;
/** Batches in one drain; a queue with more is drained again right after */
const MAX_BATCHES = 50;
/** How long one drain runs before it leaves the rest to the next, however slow each message is */
const MAX_DRAIN_MS = 10 * 60 * 1000;
/** Long enough that a message left in the queue is not read again by the same drain */
const READ_VISIBILITY_SECONDS = 900;
/**
 * A message the webhook asked to have again is read again after this long, doubled with every read.
 * SQS takes at most 12 hours from when the message was read, and refuses more; a drain settles a
 * message within its own 10 minutes of reading it, so this stays under what is left.
 */
const RETRY_VISIBILITY_SECONDS = 600;
const RETRY_VISIBILITY_MAX_SECONDS = 42_000;
/** Messages asked for again, or refused, in a row after which a drain stops: what fails them fails the rest */
const MAX_FAILURES_IN_A_ROW = 3;
/**
 * A refused signature is taken for a passing failure (SNS's certificate briefly not found) until
 * the message was read this many times: a forged one comes from no other path but the queue's
 * policy, and a real one must not be lost to a moment of DNS.
 */
const SIGNATURE_RETRY_RECEIVES = 4;
/**
 * A message that fails every time is given up on once it was read this many times, more than a
 * day after SNS published it, in a drain where another message went through: what fails it is not
 * the database, AWS or Redis, which a message just handled shows to be up.
 */
const POISON_RECEIVES = 8;
const POISON_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the webhook may take over one message. A deploy that stops the worker halfway may still
 * cut it short: the message comes back when its visibility ends. A bounce or complaint is then
 * found recorded; an open or click whose handling was cut between its count and its mark as handled
 * counts again, as when SNS itself delivers it twice.
 */
const HANDLER_TIMEOUT_MS = 20_000;
/**
 * Past this, an open, a click, a delivery or an inbound email is dropped instead of handled: the
 * webhook no longer remembers having handled it (SnsMessages), and it would count again
 */
const COUNTED_EVENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How much of a message given up on is logged, so what it was about can still be found */
const LOGGED_BODY_MAX = 2000;

const MISSING_QUEUE_ERRORS = new Set(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);
const ACCESS_ERRORS = new Set(['AccessDenied', 'AccessDeniedException']);

/** What a refusal is about: reading the queue's size, or reading and settling its messages */
type Access = 'read' | 'drain';
const accessSource = (access: Access) => `${DLQ_ACCESS_SOURCE}:${access}`;

type Outcome = 'handled' | 'old' | 'retry' | 'invalid';

interface Handled {
  outcome: Outcome;
  type: string;
  /** The project of the email the event is about; undefined when there is none */
  projectId?: string;
  /** The project could not be looked up: the database failed */
  lookupFailed?: boolean;
  reason?: string;
  keptSubscribed?: boolean;
  /** The webhook did not answer in time and may still be running: the drain stops */
  stalled?: boolean;
  /** Asked for again, or refused, for a reason that fails the next ones too */
  failing?: boolean;
  /** Asked for again, but failing every time, for long: given up on if another goes through */
  poison?: boolean;
}

/** What one drain did in a project, or with what belongs to none */
interface Tally {
  /** Handled, by SES event type */
  handled: Map<string, number>;
  /** Dropped as too old to handle, by SES event type */
  old: Map<string, number>;
  /** Complaints of contacts who subscribed again since, left subscribed */
  keptSubscribed: number;
  /** Given up on: the message id and why */
  invalid: string[];
}

interface DlqDrainResult {
  handled: number;
  old: number;
  retry: number;
  invalid: number;
  /** Whether the queue may hold more than this drain read: it should run again */
  more: boolean;
}

let queueUrl: Promise<string> | undefined;
// A queue the installation does not have is logged once per process, not every 15 minutes
let missingQueueLogged = false;

function getQueueUrl(): Promise<string> {
  queueUrl ??= getAwsAccountId()
    .then(account => `https://sqs.${AWS_SES_REGION}.amazonaws.com/${account}/${DLQ_NAME}`)
    .catch((error: unknown) => {
      queueUrl = undefined;
      throw error;
    });
  return queueUrl;
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

/**
 * Whether AWS refused the call for lack of permission: by the error's name, or by a 403 that names
 * nothing more precise (an invalid or expired key, a skewed clock, are 403s with names of their own)
 */
function isAccessError(error: unknown): boolean {
  const name = errorName(error);
  const status = (error as {$metadata?: {httpStatusCode?: unknown}} | undefined)?.$metadata?.httpStatusCode;
  return ACCESS_ERRORS.has(name) || (status === 403 && (name === '' || name === 'Error'));
}

/** How long a message asked for again waits before it is read again, by how often it was read */
function retryVisibility(receives: number): number {
  return Math.min(RETRY_VISIBILITY_SECONDS * 2 ** Math.max(0, receives - 1), RETRY_VISIBILITY_MAX_SECONDS);
}

const receivesOf = (message: Message) => Number(message.Attributes?.ApproximateReceiveCount ?? 1);

const emptyTally = (): Tally => ({handled: new Map(), old: new Map(), keptSubscribed: 0, invalid: []});

function tallyOf(tallies: Map<string, Tally>, projectId: string): Tally {
  let tally = tallies.get(projectId);
  if (!tally) {
    tally = emptyTally();
    tallies.set(projectId, tally);
  }
  return tally;
}

/** Adds one to a count kept by SES event type */
function bump(counts: Map<string, number>, type: string): void {
  counts.set(type, (counts.get(type) ?? 0) + 1);
}

function describe(counts: Map<string, number>): string {
  return [...counts].map(([type, count]) => `${count} ${type.toLowerCase()}`).join(', ');
}

/** What a tally says: handled, dropped, kept subscribed, given up on; empty when it is empty */
function describeTally(tally: Tally): string {
  return [
    tally.handled.size ? `Handled: ${describe(tally.handled)}.` : '',
    tally.old.size ? `Dropped as older than 24 hours: ${describe(tally.old)}.` : '',
    tally.keptSubscribed
      ? `${tally.keptSubscribed} ${tally.keptSubscribed === 1 ? 'contact who complained was' : 'contacts who complained were'} left subscribed, having subscribed again since; their addresses are suppressed.`
      : '',
    tally.invalid.length
      ? `${tally.invalid.length} could not be handled and were deleted; their content is in the worker's log (${tally.invalid.slice(0, 5).join('; ')}).`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export class DlqDrainService {
  /**
   * Whether the queue needs draining, and if it is empty, the alarm's notice closed: the alarm goes
   * back to OK as soon as a drain reads the messages, before they are handled, so it cannot say.
   * False when it cannot tell: no such queue (an installation set up without it) or no permission,
   * which is shown on the dashboard until it works again.
   */
  public static async check(): Promise<boolean> {
    const counted = await this.count();
    if (!counted) {
      return false;
    }
    if (counted.visible + counted.inFlight === 0) {
      await FailureAlertService.resolve(DLQ_ALARM_SOURCE);
    }
    return counted.visible > 0;
  }

  /**
   * How many messages the queue holds: visible, and in flight (read by a drain and not yet back).
   * Null when it cannot say.
   */
  private static async count(): Promise<{visible: number; inFlight: number} | null> {
    const counted = await this.query();
    return 'error' in counted ? null : counted;
  }

  /**
   * Whether the queue can be counted at all: false when it does not exist or may not be read, so
   * the drain will never say it is empty; undefined when it could not be reached just now
   */
  public static async canCount(): Promise<boolean | undefined> {
    const counted = await this.query();
    if (!('error' in counted)) {
      return true;
    }
    return MISSING_QUEUE_ERRORS.has(errorName(counted.error)) || isAccessError(counted.error) ? false : undefined;
  }

  private static async query(): Promise<{visible: number; inFlight: number} | {error: unknown}> {
    try {
      const {Attributes} = await sqs.getQueueAttributes({
        QueueUrl: await getQueueUrl(),
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      });
      await FailureAlertService.resolve(accessSource('read'));
      return {
        visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    } catch (error) {
      await this.reportAccess(error, 'read');
      return {error};
    }
  }

  /**
   * Reads the queue until it is empty, handing each message to the webhook. A message is deleted
   * once the webhook has handled it, or once it never will: another account's or unreadable at
   * once, a refused signature after a few reads, one that fails every time once others go through.
   * One the webhook asks to have again comes back later. `stopping` is asked between messages, so
   * a worker shutting down leaves the rest for the next drain.
   */
  public static async drain(stopping: () => boolean = () => false): Promise<DlqDrainResult> {
    const result: DlqDrainResult = {handled: 0, old: 0, retry: 0, invalid: 0, more: false};
    const tallies = new Map<string, Tally>();
    const unattributed = emptyTally();
    const startedAt = Date.now();
    // Failing every time, kept in flight until the end of the drain says whether anything went through
    const poisoned: {message: Message; handled: Handled}[] = [];
    let anyHandled = false;
    let lookupsFailed = 0;

    let url: string;
    try {
      url = await getQueueUrl();
    } catch (error) {
      await this.reportAccess(error, 'drain');
      return result;
    }

    // The queue answers again: its notice of no access is closed, once a drain, unless this drain
    // was refused settling a message
    let drainAllowed = false;
    let settleRefused = false;
    const allowDrain = async () => {
      if (!drainAllowed && !settleRefused) {
        drainAllowed = true;
        await FailureAlertService.resolve(accessSource('drain'));
      }
    };

    /** Settles a message and counts it under its project */
    const conclude = async (message: Message, handled: Handled) => {
      const {outcome, type, projectId, lookupFailed, reason, keptSubscribed} = handled;
      if (outcome === 'invalid') {
        // Logged before it is deleted: the dashboard only says that it was
        signale.warn(
          `[DLQ] Giving up on message ${message.MessageId} (${reason}, project ${projectId ?? 'unknown'}): ${(message.Body ?? '').slice(0, LOGGED_BODY_MAX)}`,
        );
      }
      const settled = await this.settle(url, message, outcome);
      if (settled !== 'settled') {
        settleRefused ||= settled === 'refused';
        return;
      }
      await allowDrain();
      result[outcome]++;
      if (outcome === 'retry') {
        return;
      }
      if (lookupFailed) {
        // Whose it is cannot be said: neither in one project's notice nor in all of them
        lookupsFailed++;
        return;
      }
      const tally = projectId ? tallyOf(tallies, projectId) : unattributed;
      if (outcome === 'invalid') {
        tally.invalid.push(`${message.MessageId ?? '?'}: ${reason}`);
      } else {
        bump(tally[outcome], type);
        if (keptSubscribed) {
          tally.keptSubscribed++;
        }
      }
    };

    let emptyReads = 0;
    let failuresInARow = 0;
    drain: for (let batch = 0; batch < MAX_BATCHES; batch++) {
      if (stopping() || Date.now() - startedAt > MAX_DRAIN_MS) {
        result.more = true;
        break;
      }

      let messages: Message[];
      try {
        // A short wait, as a read without one asks only some of SQS's servers and can come back
        // empty with messages still there
        ({Messages: messages = []} = await sqs.receiveMessage({
          QueueUrl: url,
          MaxNumberOfMessages: BATCH,
          WaitTimeSeconds: 2,
          VisibilityTimeout: READ_VISIBILITY_SECONDS,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
      } catch (error) {
        await this.reportAccess(error, 'drain');
        break;
      }

      if (messages.length === 0) {
        // Read, with nothing to settle: reading is allowed again
        await allowDrain();
        if (++emptyReads >= 2) {
          break;
        }
        continue;
      }
      emptyReads = 0;

      for (const [index, message] of messages.entries()) {
        // Shutting down, or Redis down (the webhook would hang on it and an open count twice):
        // what was read and not handled goes straight back to the queue
        if (stopping() || !redisReady()) {
          result.more = stopping();
          await this.giveBack(url, messages.slice(index));
          break drain;
        }
        const handled = await this.handle(message);
        if (handled.outcome === 'handled') {
          anyHandled = true;
        }

        if (handled.poison) {
          poisoned.push({message, handled});
        } else {
          await conclude(message, handled);
        }

        // What fails one message (the database, STS, SNS's certificates) fails the next: the drain
        // stops, and the messages come back when it is over, instead of each being read again
        failuresInARow = handled.failing ? failuresInARow + 1 : 0;
        if (handled.stalled || failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          signale.warn(
            `[DLQ] Stopping: ${handled.stalled ? 'the webhook did not answer in time' : `${failuresInARow} messages in a row failed`}`,
          );
          await this.giveBack(url, messages.slice(index + 1));
          break drain;
        }
      }
      if (batch === MAX_BATCHES - 1) {
        result.more = true;
      }
    }

    // A message that fails every time is given up on only beside one that went through
    for (const {message, handled} of poisoned) {
      await conclude(
        message,
        anyHandled
          ? {
              ...handled,
              outcome: 'invalid',
              reason: `failed in each of its ${receivesOf(message)} reads over more than a day, while others went through`,
            }
          : handled,
      );
    }

    if (lookupsFailed) {
      signale.warn(`[DLQ] ${lookupsFailed} messages could not be told apart by project: the database failed`);
    }
    await this.record(tallies, unattributed);
    signale.info(
      `[DLQ] Drained: ${result.handled} handled, ${result.old} dropped as too old, ${result.retry} left for later, ${result.invalid} given up on`,
    );
    return result;
  }

  /** What to do with one message: hand it to the webhook, or drop it */
  private static async handle(message: Message): Promise<Handled> {
    const envelope = parseSnsMessage(message.Body);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return {outcome: 'invalid', type: 'unknown', reason: 'not an SNS message'};
    }
    const fields = envelope as Record<string, unknown>;
    // A subscription's dead-letter queue only gets notifications; anything else is not SNS's
    if (fields.Type !== 'Notification') {
      return {outcome: 'invalid', type: 'unknown', reason: `an SNS message of type ${String(fields.Type)}`};
    }
    const notification = readSesNotification(parseSnsMessage(fields.Message));
    const type = notification.kind === 'event' ? notification.eventType : 'other';
    const owner = notification.kind === 'event' ? await this.projectOf(notification.mail) : {};

    // An open, a click, a delivery or an inbound email the webhook may have handled already: past
    // the day it remembers that for, it would count again. The queue only takes messages from the
    // account's topic (its policy), so it is dropped without checking its signature.
    const publishedAt = Date.parse(typeof fields.Timestamp === 'string' ? fields.Timestamp : '');
    if (
      SnsMessages.deduplicates(type) &&
      (!Number.isFinite(publishedAt) || Date.now() - publishedAt > COUNTED_EVENTS_MAX_AGE_MS)
    ) {
      return {outcome: 'old', type, ...owner};
    }

    const receives = receivesOf(message);
    try {
      // Imported here: the webhook's controller pulls in most of the API, and the services it
      // uses would otherwise import it back
      const {Webhooks} = await import('../controllers/Webhooks.js');
      const webhooks = new Webhooks();
      const answer = await invokeHandler(webhooks.receiveSNSWebhook.bind(webhooks), envelope, {
        extra: {[DLQ_REPLAY]: true},
        timeoutMs: HANDLER_TIMEOUT_MS,
      });
      if (answer.status < 300) {
        const keptSubscribed = (answer.body as {keptSubscribed?: unknown} | undefined)?.keptSubscribed === true;
        return {outcome: 'handled', type, ...owner, keptSubscribed};
      }
      if (answer.status === 403) {
        const message403 = (answer.body as {message?: unknown} | undefined)?.message;
        if (message403 === 'Untrusted SNS topic') {
          return {outcome: 'invalid', type, ...owner, reason: 'its topic is of another AWS account'};
        }
        // A signature refused because SNS's certificate was not found a moment ago: read again a
        // few times before it is given up on
        return receives < SIGNATURE_RETRY_RECEIVES
          ? {outcome: 'retry', type, ...owner, failing: true}
          : {
              outcome: 'invalid',
              type,
              ...owner,
              failing: true,
              reason: `its signature was refused in ${receives} reads`,
            };
      }
      signale.warn(`[DLQ] The webhook asked for message ${message.MessageId} again (${answer.status}, ${type})`);
    } catch (error) {
      signale.warn(`[DLQ] The webhook failed on message ${message.MessageId} (${type}):`, error);
      if (error instanceof HandlerTimedOut) {
        return {outcome: 'retry', type, ...owner, failing: true, stalled: true};
      }
    }
    return {
      outcome: 'retry',
      type,
      ...owner,
      failing: true,
      poison:
        receives >= POISON_RECEIVES && Number.isFinite(publishedAt) && Date.now() - publishedAt > POISON_MIN_AGE_MS,
    };
  }

  /**
   * The project an SES event belongs to, for its summary: the email it is about, or else the email
   * its tag names. Never the tag's project alone: what is dropped unchecked could name any.
   */
  private static async projectOf(mail: {
    messageId: string;
    tags?: Record<string, unknown>;
  }): Promise<{projectId?: string; lookupFailed?: boolean}> {
    try {
      const {emailId} = sesTags(mail);
      const email =
        (await prisma.email.findUnique({where: {messageId: mail.messageId}, select: {projectId: true}})) ??
        (emailId ? await prisma.email.findUnique({where: {id: emailId}, select: {projectId: true}}) : null);
      return email ? {projectId: email.projectId} : {};
    } catch {
      return {lookupFailed: true};
    }
  }

  /** Deletes a message that is done with, or has it come back later: whether that worked, or was refused */
  private static async settle(
    url: string,
    message: Message,
    outcome: Outcome,
  ): Promise<'settled' | 'failed' | 'refused'> {
    if (!message.ReceiptHandle) {
      return 'failed';
    }
    try {
      if (outcome === 'retry') {
        await sqs.changeMessageVisibility({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: retryVisibility(receivesOf(message)),
        });
      } else {
        await sqs.deleteMessage({QueueUrl: url, ReceiptHandle: message.ReceiptHandle});
      }
      return 'settled';
    } catch (error) {
      // Left as it is: it comes back when its visibility ends, and is handled again. Without the
      // permission to settle it, that is every time: shown like any other refusal.
      signale.warn(`[DLQ] Could not settle message ${message.MessageId} (${errorName(error) || 'error'}):`, error);
      if (isAccessError(error)) {
        await this.reportAccess(error, 'drain');
        return 'refused';
      }
      return 'failed';
    }
  }

  /** Messages read and left unhandled, back in the queue at once rather than after their visibility */
  private static async giveBack(url: string, messages: Message[]): Promise<void> {
    for (const message of messages) {
      if (!message.ReceiptHandle) continue;
      try {
        await sqs.changeMessageVisibility({QueueUrl: url, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0});
      } catch (error) {
        // Back after its visibility instead
        signale.warn(`[DLQ] Could not give message ${message.MessageId} back to the queue:`, error);
      }
    }
  }

  /**
   * Says on each project's dashboard what the latest drain took back for it, and on every one only
   * what belongs to none: a message tells nothing about any other project. A drain that only had
   * messages come back later says nothing.
   */
  private static async record(tallies: Map<string, Tally>, unattributed: Tally): Promise<void> {
    for (const [projectId, tally] of tallies) {
      const said = describeTally(tally);
      if (!said) continue;
      await FailureAlertService.record(
        projectId,
        {
          sourceKey: DLQ_SUMMARY_SOURCE,
          label: tally.invalid.length ? 'AWS dead-letter queue: messages deleted' : 'AWS dead-letter queue',
          error: `SES events SNS could not deliver, taken back from the AWS dead-letter queue in its latest drain. ${said}`,
        },
        {alert: false},
      );
    }

    const said = describeTally(unattributed);
    if (!said) {
      return;
    }
    await FailureAlertService.recordForAll(
      {
        sourceKey: DLQ_INVALID_SOURCE,
        label: 'AWS dead-letter queue',
        error: `Messages of the AWS dead-letter queue of SES events that belong to no project, in its latest drain. ${said}`,
      },
      {includeDisabled: true, alert: false},
    );
  }

  /**
   * A queue the installation does not have is only logged: it was set up without it. No permission
   * is shown on every dashboard, apart for reading the queue's size and for reading and settling its
   * messages, each closed once that works again.
   */
  private static async reportAccess(error: unknown, access: Access): Promise<void> {
    if (MISSING_QUEUE_ERRORS.has(errorName(error))) {
      if (!missingQueueLogged) {
        missingQueueLogged = true;
        signale.info(`[DLQ] No ${DLQ_NAME} queue in this AWS account: nothing to drain`);
      }
      return;
    }
    if (!isAccessError(error)) {
      signale.warn(`[DLQ] Could not reach ${DLQ_NAME}:`, error);
      return;
    }
    signale.warn(`[DLQ] Not allowed to ${access === 'read' ? 'count' : 'drain'} ${DLQ_NAME}:`, error);
    await FailureAlertService.recordForAll(
      {
        sourceKey: accessSource(access),
        label: 'AWS dead-letter queue not readable',
        error: `Plunk cannot ${access === 'read' ? 'see how many messages there are in' : 'take messages back from'} ${DLQ_NAME}, where SNS leaves the SES events it could not deliver: give the SES credentials sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility and sqs:GetQueueAttributes on it.`,
      },
      {includeDisabled: true, alert: false},
    );
  }
}
