/**
 * Plunk Lite's double opt-in: a sign-up from the API waits, unsubscribed, until the contact confirms
 * it from a link in a confirmation email (see OptInService in the API).
 */

/** A project's confirmation email in one language */
export interface OptInText {
  subject: string;
  text: string;
  buttonText: string;
}

/** A project's confirmation emails, by language code; languages without one get Plunk's */
export type OptInTexts = Partial<Record<string, OptInText>>;

/** A project's double opt-in, as the dashboard reads and saves it */
export interface OptInSettingsData {
  enabled: boolean;
  fromEmail: string | null;
  fromName: string | null;
  texts: OptInTexts;
}

/**
 * What a sign-up waiting for confirmation came to:
 * - `sent`: a confirmation email is on its way;
 * - `throttled`: one went out a moment ago, or the contact's limits are spent;
 * - `capped`: the project sent too many in the last hour or day;
 * - `failed`: the email could not be queued (the sender's domain, a billing limit);
 * - `held`: no email is sent for this sign-up (the public key, an import), and the contact stays
 *   as it was.
 */
export type OptInOutcome = 'sent' | 'throttled' | 'capped' | 'failed' | 'held';

/** A contact's confirmation request, as its page in the dashboard shows it */
export interface OptInRequestInfo<TDate = Date> {
  createdAt: TDate;
  lastSentAt: TDate | null;
  sends: number;
  confirmedAt: TDate | null;
  withdrawnAt: TDate | null;
}

/** What the confirmation page shows for its link */
export type OptInLink =
  | {status: 'invalid'}
  | {status: 'pending' | 'confirmed'; projectName: string; email: string; language: string};
