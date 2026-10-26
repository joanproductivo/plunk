import {isFailureNotice} from '@plunk/shared';
import type {FailureAlert} from '@plunk/types';

/** The URL a project's open failures are read from */
export const failuresUrl = (projectId: string) => `/projects/${projectId}/alerts/failures`;

/** The URL a project's alert settings are read from and saved to */
export const alertSettingsUrl = (projectId: string) => `/projects/${projectId}/alerts/settings`;

const ERROR_SHOWN = 140;

/**
 * How often a source failed and since when, e.g. "Failed 3 times since 26 Oct, 10:42"; for a
 * condition such as the sending reputation, how often it was seen
 */
export function describeFailure(
  failure: Pick<FailureAlert, 'sourceKey' | 'count' | 'firstAt'>,
  locale?: string,
): string {
  const since = new Date(failure.firstAt).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const verb = isFailureNotice(failure.sourceKey) ? 'Seen' : 'Failed';
  return `${verb} ${failure.count} ${failure.count === 1 ? 'time' : 'times'} since ${since}`;
}

/** The last error, cut to what fits on the banner */
export function shortError(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length > ERROR_SHOWN ? `${oneLine.slice(0, ERROR_SHOWN - 1)}…` : oneLine;
}

/** The addresses typed in the settings, one per line or separated by commas */
export function parseRecipients(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,;]/)
        .map(address => address.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
