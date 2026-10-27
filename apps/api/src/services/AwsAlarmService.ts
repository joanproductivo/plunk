import signale from 'signale';

import {redis} from '../database/redis.js';

import {FailureAlertService} from './FailureAlertService.js';
import {snsTopicAccountId} from './SecurityService.js';

/** The fields of a CloudWatch alarm notification the webhook reads */
export interface AwsAlarm {
  AlarmName: string;
  NewStateValue: string;
  AlarmArn: string;
  AWSAccountId: string;
  NewStateReason?: unknown;
  StateChangeTime?: unknown;
}

// The latest state change applied, per alarm, as milliseconds since the epoch
const LATEST_KEY = (alarmName: string) => `plunk-lite:alarm:${alarmName}`;
// Far longer than SNS keeps retrying a notification
const LATEST_SECONDS = 30 * 86400;

// Moves the latest state change forward only: an older one arriving late leaves it as it is
const RAISE_LATEST = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
end
return 1`;

/**
 * Plunk Lite: the AWS account's CloudWatch alarms (bounce and complaint rates, the dead-letter queue
 * of SES events), shown on the dashboard of every project. Their topic is subscribed to the same
 * webhook as SES's events. AWS emails the alarms itself, which still works with Plunk down, so here
 * they are only shown: an alarm opens a notice in the banner, and its return to OK closes it.
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

  /**
   * Shows the alarm going into ALARM, in every project including disabled ones, and hides it once
   * it is OK again. INSUFFICIENT_DATA changes nothing, nor does a state change older than the last
   * one applied (SNS does not keep them in order).
   */
  public static async handle(alarm: AwsAlarm): Promise<void> {
    if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') {
      signale.info(`[ALARMS] ${alarm.AlarmName} is ${alarm.NewStateValue}, nothing to show`);
      return;
    }

    const changedAt = Date.parse(typeof alarm.StateChangeTime === 'string' ? alarm.StateChangeTime : '');
    if (Number.isFinite(changedAt) && !(await this.isLatest(alarm.AlarmName, changedAt))) {
      signale.info(`[ALARMS] Ignoring an older state change of ${alarm.AlarmName}`);
      return;
    }

    const sourceKey = `aws:alarm:${alarm.AlarmName}`;
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
    } else {
      signale.info(`[ALARMS] ${alarm.AlarmName} is back to OK`);
      await FailureAlertService.resolve(sourceKey);
    }

    if (Number.isFinite(changedAt)) {
      await redis
        .eval(RAISE_LATEST, 1, LATEST_KEY(alarm.AlarmName), String(changedAt), String(LATEST_SECONDS))
        .catch((error: unknown) => signale.warn(`[ALARMS] Could not keep the state of ${alarm.AlarmName}:`, error));
    }
  }

  /**
   * Whether a state change is newer than the last one applied. If Redis cannot say, it is applied:
   * showing a state that may be stale beats missing an alarm.
   */
  private static async isLatest(alarmName: string, changedAt: number): Promise<boolean> {
    try {
      const latest = Number((await redis.get(LATEST_KEY(alarmName))) ?? 0);
      return changedAt > latest;
    } catch (error) {
      signale.warn(`[ALARMS] Could not read the last state change of ${alarmName}:`, error);
      return true;
    }
  }
}
