import signale from 'signale';

import {redis} from '../database/redis.js';

import {alarmSource, DLQ_ALARM_NAME, DLQ_ALARM_SOURCE, DLQ_NAME} from './dlqConstants.js';
import {FailureAlertService} from './FailureAlertService.js';
import {QueueService} from './QueueService.js';
import {snsTopicAccountId} from './SecurityService.js';

/** The fields of a CloudWatch alarm notification the webhook reads */
export interface AwsAlarm {
  AlarmName: string;
  NewStateValue: string;
  AlarmArn: string;
  AWSAccountId: string;
  NewStateReason?: unknown;
  StateChangeTime?: unknown;
  /** The metric the alarm watches, with its dimensions */
  Trigger?: unknown;
}

/**
 * Whether an alarm is the one on the dead-letter queue of SES events having messages: by the metric
 * and queue it watches, however it is named, or else by the name the skill gives it. CloudWatch
 * writes the dimensions as `{name, value}`; `{Name, Value}` is read too.
 */
function watchesDlq(alarm: AwsAlarm): boolean {
  const trigger = alarm.Trigger as {MetricName?: unknown; Dimensions?: unknown} | undefined;
  const dimensions = trigger?.Dimensions;
  if (Array.isArray(dimensions)) {
    return trigger?.MetricName === 'ApproximateNumberOfMessagesVisible' && dimensions.some(dimension => {
      const fields = dimension && typeof dimension === 'object' ? (dimension as Record<string, unknown>) : {};
      return (fields.name ?? fields.Name) === 'QueueName' && (fields.value ?? fields.Value) === DLQ_NAME;
    });
  }
  return alarm.AlarmName === DLQ_ALARM_NAME;
}

/**
 * The name of the alarms' topic, as the skill that sets an installation up creates it
 * (plunk-dokploy-ses). A topic renamed is not recognised, and what comes from it is treated as from
 * any topic: reported, the side that tells.
 */
export const ALARMS_TOPIC_NAME = 'plunk-alarmas';

// The latest state change applied, per alarm, as milliseconds since the epoch
const LATEST_KEY = (alarmName: string) => `plunk-lite:alarm:${alarmName}`;
// Far longer than SNS keeps retrying a notification
const LATEST_SECONDS = 30 * 86400;

// Moves the latest state change forward only, and says whether it did: 1 for a newer one, 0 for one
// that is not, arriving late or again. Compared and set at once, so of two notifications handled
// together only the newer one is applied.
const RAISE_LATEST = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0`;

/**
 * Plunk Lite: the AWS account's CloudWatch alarms (bounce and complaint rates, the dead-letter queue
 * of SES events), shown on the dashboard of every project. Their topic is subscribed to the same
 * webhook as SES's events. AWS emails the alarms itself, which still works with Plunk down, so here
 * they are only shown: an alarm opens a notice in the banner, and its return to OK closes it (the one
 * on the dead-letter queue also has it drained, and the drain closes its notice once it is empty).
 */
export class AwsAlarmService {
  /**
   * Whether a notification is a CloudWatch alarm of this installation's AWS account rather than an
   * SES event. The topic it came from was already checked to be the account's own.
   */
  public static isAlarm(body: unknown, topicArn: unknown): body is AwsAlarm {
    if (!body || typeof body !== 'object') {
      return false;
    }
    const fields = body as Record<string, unknown>;
    return (
      typeof fields.AlarmName === 'string' &&
      typeof fields.NewStateValue === 'string' &&
      typeof fields.AlarmArn === 'string' &&
      !('mail' in fields) &&
      typeof fields.AWSAccountId === 'string' &&
      fields.AWSAccountId === snsTopicAccountId(topicArn)
    );
  }

  /** Whether a topic is the alarms' one, by the last part of its ARN */
  public static isAlarmsTopic(topicArn: unknown): boolean {
    return typeof topicArn === 'string' && topicArn.split(':').pop() === ALARMS_TOPIC_NAME;
  }

  /**
   * The webhook's subscription to the alarms' topic was removed: the alarms no longer reach the
   * dashboard, while AWS still emails them. Shown in every project, disabled ones included.
   */
  public static async reportSubscriptionRemoved(topic: string): Promise<void> {
    signale.warn(`[ALARMS] SNS subscription to ${topic} was removed`);
    await FailureAlertService.recordForAll(
      {
        sourceKey: 'aws:alarm-subscription',
        label: 'AWS alarms no longer reach the dashboard; their emails still do',
        error: `This server was unsubscribed from ${topic}: the AWS account's alarms no longer show here, though AWS still emails them. Subscribe the webhook to it again.`,
      },
      {includeDisabled: true, alert: false},
    );
  }

  /**
   * Shows the alarm going into ALARM, in every project including disabled ones, and hides it once
   * it is OK again -- except the one on the dead-letter queue, which also has it drained and whose
   * notice the drain closes once the queue is empty. INSUFFICIENT_DATA changes nothing, nor does a
   * state change older than the last one applied (SNS does not keep them in order).
   */
  public static async handle(alarm: AwsAlarm): Promise<void> {
    if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') {
      signale.info(`[ALARMS] ${alarm.AlarmName} is ${alarm.NewStateValue}, nothing to show`);
      return;
    }

    const watchesQueue = watchesDlq(alarm);
    if (watchesQueue && alarm.NewStateValue === 'ALARM') {
      // Before the state change is claimed, so a copy SNS delivers again after a later failure here
      // still asks for it rather than being ignored as applied. Bounded and never thrown, so the
      // notice is still shown.
      try {
        await QueueService.queueDlqDrain();
      } catch (error) {
        signale.error('[ALARMS] Could not queue the drain of the dead-letter queue:', error);
      }
    }

    const changedAt = Date.parse(typeof alarm.StateChangeTime === 'string' ? alarm.StateChangeTime : '');
    if (Number.isFinite(changedAt) && !(await this.claimLatest(alarm.AlarmName, changedAt))) {
      signale.info(`[ALARMS] Ignoring an older state change of ${alarm.AlarmName}`);
      return;
    }

    // The queue's alarm under one source whatever its name, the one the drain closes
    const sourceKey = watchesQueue ? DLQ_ALARM_SOURCE : alarmSource(alarm.AlarmName);
    if (alarm.NewStateValue === 'ALARM') {
      signale.warn(`[ALARMS] ${alarm.AlarmName} is in ALARM`);
      await FailureAlertService.recordForAll(
        {
          sourceKey,
          label: alarm.AlarmName,
          error:
            typeof alarm.NewStateReason === 'string' && alarm.NewStateReason
              ? alarm.NewStateReason
              : 'The alarm went into ALARM.',
        },
        // A disabled project is the one that most needs to see it; the emails are AWS's
        {includeDisabled: true, alert: false},
      );
    } else if (watchesQueue) {
      // OK as soon as a drain reads the messages, before they are handled: the drain closes the
      // notice once the queue is empty. One opened under the alarm's own name, before the queue's
      // alarm had a source of its own, is closed here.
      signale.info(`[ALARMS] ${alarm.AlarmName} is back to OK; its notice closes once the queue is empty`);
      if (alarmSource(alarm.AlarmName) !== DLQ_ALARM_SOURCE) {
        await FailureAlertService.resolve(alarmSource(alarm.AlarmName));
      }
    } else {
      signale.info(`[ALARMS] ${alarm.AlarmName} is back to OK`);
      await FailureAlertService.resolve(sourceKey);
    }
  }

  /**
   * Whether a state change is newer than the last one applied, keeping it as the latest if it is,
   * before it is applied. If Redis cannot say, it is applied: showing a state that may be stale
   * beats missing an alarm.
   */
  private static async claimLatest(alarmName: string, changedAt: number): Promise<boolean> {
    try {
      const raised = await redis.eval(
        RAISE_LATEST,
        1,
        LATEST_KEY(alarmName),
        String(changedAt),
        String(LATEST_SECONDS),
      );
      return raised === 1;
    } catch (error) {
      signale.warn(`[ALARMS] Could not compare the state change of ${alarmName} with the last one:`, error);
      return true;
    }
  }
}
