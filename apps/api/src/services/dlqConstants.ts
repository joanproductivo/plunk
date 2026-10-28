/**
 * Plunk Lite: the names the skill that sets an installation up (plunk-dokploy-ses) gives the SQS
 * dead-letter queue of SES events and its CloudWatch alarm. A leaf module, so the alarms, the queue
 * and the drain can share them without importing one another.
 */

/** Where SNS leaves the SES events it could not deliver to the webhook, for 14 days */
export const DLQ_NAME = 'plunk-ses-events-dlq';

/** The alarm on that queue having messages */
export const DLQ_ALARM_NAME = 'ses-eventos-dlq';

/** The source an alarm's notice is recorded under (AwsAlarmService) */
export const alarmSource = (alarmName: string) => `aws:alarm:${alarmName}`;

/** The source the queue's alarm notice is recorded under, whatever the alarm is called */
export const DLQ_ALARM_SOURCE = alarmSource(DLQ_ALARM_NAME);

/** The notices of the drain (FailureAlertService): what it took back for a project, what it dropped, no access */
export const DLQ_SUMMARY_SOURCE = 'aws:dlq';
export const DLQ_INVALID_SOURCE = 'aws:dlq-invalid';
export const DLQ_ACCESS_SOURCE = 'aws:dlq-access';

/**
 * Set on the request the drain hands a message to the webhook with: the event is recorded as taken
 * back from the queue, and a refused one is not counted as a rejection of what SNS delivers
 */
export const DLQ_REPLAY = 'plunkLiteReplay';

/** Whether the webhook was called by the drain rather than by SNS: set on the request itself, never inherited */
export function isDlqReplay(req: object): boolean {
  return Object.hasOwn(req, DLQ_REPLAY) && (req as Record<string, unknown>)[DLQ_REPLAY] === true;
}
