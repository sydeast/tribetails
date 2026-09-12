import type { AdminAccess } from './access';
import type { UserProfile } from '../api/account';

/**
 * Pure display helpers for the Account overview, kept out of the screen so the
 * name/label/date logic has direct vitest coverage (the invoiceFormat.ts /
 * sessionFormat.ts convention). All inputs are treated as possibly-blank and
 * defaulted; nothing here throws on an empty profile or a null auth field.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** "First Last" from the profile, blanks dropped, or "" when neither is set. */
export function profileFullName(p: Pick<UserProfile, 'firstName' | 'lastName'>): string {
  return [p.firstName, p.lastName]
    .map((s) => (s ?? '').trim())
    .filter((s) => s !== '')
    .join(' ');
}

/**
 * The name to show, resolved in priority order: the profile's own displayName,
 * then First+Last, then the Firebase Auth displayName, then the email local-part,
 * and only then the honest "Operator" fallback. Never blank, never "undefined".
 */
export function profileDisplayName(
  p: Pick<UserProfile, 'displayName' | 'firstName' | 'lastName'>,
  authDisplayName: string | null,
  authEmail: string | null,
): string {
  const dn = (p.displayName ?? '').trim();
  if (dn !== '') return dn;
  const full = profileFullName(p);
  if (full !== '') return full;
  const ad = (authDisplayName ?? '').trim();
  if (ad !== '') return ad;
  const email = (authEmail ?? '').trim();
  if (email !== '') {
    const local = email.split('@')[0];
    if (local !== undefined && local !== '') return local;
  }
  return 'Operator';
}

/** Up to two uppercase initials from a display name, or "?" when nothing usable. */
export function profileInitials(name: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '?';
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const a = first && first.length > 0 ? first[0] : '';
  const b = last && last.length > 0 ? last[0] : '';
  const initials = `${a}${b}`.toUpperCase();
  return initials === '' ? '?' : initials;
}

/** Human label for a Firebase Auth providerId. Falls back to the raw id, never blank. */
export function providerLabel(providerId: string): string {
  switch ((providerId ?? '').trim().toLowerCase()) {
    case 'password':
      return 'Email and password';
    case 'google.com':
      return 'Google';
    case 'apple.com':
      return 'Apple';
    case 'microsoft.com':
      return 'Microsoft';
    case '':
      return 'Unknown';
    default:
      return providerId;
  }
}

/**
 * Human label for the resolved admin access (the AppShell already resolved this).
 *
 * Null is the #812 degraded entry: the gate admitted this session without
 * reading its claims, because the device could not refresh the ID token. There
 * is no role to print, so it says that rather than defaulting to one. Naming
 * a permission level nobody checked is the one thing this label must not do.
 */
export function roleLabel(access: AdminAccess | null): string {
  if (access === null) return 'Not checked while offline';
  switch (access.status) {
    case 'admin':
      return 'Operator (full admin)';
    case 'testAdmin':
      return 'Test admin (sandbox)';
    case 'denied':
      return 'No access';
  }
}

/**
 * LOCAL "Mon D, YYYY, HH:mm" for a Firebase Auth metadata timestamp
 * (creationTime / lastSignInTime are RFC-1123 strings, e.g. "Wed, 16 Jul 2026
 * 20:05:00 GMT"). Uses local getters, so it reads in the operator's wall-clock
 * zone (the AO-18 principle). "Unknown" when blank; the raw text verbatim when
 * unparseable (fail-loud, never a fabricated date).
 */
export function authDateLabel(raw: string): string {
  const t = (raw ?? '').trim();
  if (t === '') return 'Unknown';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const month = MONTHS[d.getMonth()] ?? '';
  return `${month} ${d.getDate()}, ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Verified badge label. */
export function emailVerifiedLabel(verified: boolean): string {
  return verified ? 'Verified' : 'Not verified';
}
