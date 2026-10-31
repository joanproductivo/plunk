/**
 * Plunk Lite: the steps a failed execution can be retried from by hand. Not a delay or a wait, which
 * move on through their own jobs and would leave the run stuck. Not an update of the contact either:
 * adding to a segment counts as an entry even for a member, so repeating one could start the
 * workflows of that segment again, and it can resend a double opt-in confirmation.
 */
const RETRYABLE_STEP_TYPES = new Set(['WEBHOOK', 'SEND_EMAIL', 'CONDITION']);

export function canRetryStepType(stepType: string): boolean {
  return RETRYABLE_STEP_TYPES.has(stepType);
}
