/**
 * An email address as Plunk stores and compares it: trimmed and lowercased. Mailbox providers
 * deliver `User@x.com` and `user@x.com` to the same inbox, so they are one address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
