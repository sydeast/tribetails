/**
 * reservedEmailDomain.ts
 *
 * Which email addresses are on a reserved or invented domain, for the #1082
 * purge script. An address on one of these domains can never receive mail, so
 * every send to it bounces and hurts the sender rating.
 *
 * Reserved (RFC 2606 / RFC 6761, plus `.local` from RFC 6762):
 *   TLDs     .test  .example  .invalid  .localhost  .local
 *   domains  example.com  example.net  example.org, and any subdomain of them
 *
 * Case-insensitive, and a trailing dot on the domain (`a@x.test.`) is tolerated.
 *
 * KEEP IN STEP. Issue #1076 (PR #1081) adds the same list to
 * `mytribe/functions/src/lib/email.ts` so the sender refuses these domains. This
 * copy exists only because that file was being changed at the same time; once
 * #1076 is merged the two lists should become one, imported from there.
 *
 * PROTECTED. The real test accounts and every `@tribetails.com` address are
 * never purge targets, whatever else is true of them. They are not on a
 * reserved domain anyway; the check is a second lock, not the first.
 */

export const RESERVED_TLDS: readonly string[] = ['test', 'example', 'invalid', 'localhost', 'local'];
export const RESERVED_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org'];

/** Real accounts the purge must never touch (operator ruling 2026-09-30, #1071). */
export const PROTECTED_EMAILS: readonly string[] = [
  'e2e-admin@tribetails.com',
  'catch@hanasamku.com',
  'pawsome@hanasamku.com',
];
export const PROTECTED_DOMAIN = 'tribetails.com';

/** The lower-cased domain of an address with any trailing dots removed, or null when it has no usable domain. */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  return domain === '' ? null : domain;
}

/** True when the address is on a reserved TLD or a reserved example domain (or its subdomain). */
export function isReservedEmail(email: unknown): boolean {
  const domain = emailDomain(email);
  if (domain === null) return false;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  if (RESERVED_TLDS.includes(tld)) return true;
  return RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True for the three real test accounts and any address at tribetails.com (or a subdomain of it). */
export function isProtectedEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase().replace(/\.+$/, '');
  if (PROTECTED_EMAILS.includes(normalized)) return true;
  const domain = emailDomain(email);
  return domain !== null && (domain === PROTECTED_DOMAIN || domain.endsWith(`.${PROTECTED_DOMAIN}`));
}
