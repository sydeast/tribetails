import { normalizeE164 } from './phoneNormalize';

/**
 * #890: when a new household is "the one this operator just added".
 *
 * Admin Add Kinfolk creates the household, then saves its Emergency Contact. If
 * the contact save failed and the operator left, the created id could be lost,
 * and the next Add made a second household for the same family. The createKinfolk
 * callable uses this rule to hand back the existing household instead, and the
 * read-only report (mytribe/scripts/reportDuplicateKinfolk.ts) uses it to find the
 * duplicates made before the callable existed.
 *
 * PURE ON PURPOSE. No firebase-admin import, so the script can load it without
 * going around mytribe/scripts/lib/firebaseAdmin.ts.
 *
 * The rule: the same primary phone OR the same primary email, compared after
 * normalising, within KINFOLK_DUPLICATE_WINDOW_MS. A blank never matches a blank:
 * two households that both left phone and email empty are not the same family.
 * The callable adds one more condition the report cannot always check: the same
 * operator uid created both.
 */

export const KINFOLK_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type DuplicateMatch = 'phone' | 'email' | 'phone and email';

/** Shortest digit run treated as a phone. Anything shorter is noise, not a number. */
const MIN_PHONE_DIGITS = 7;

/**
 * The comparable form of a phone: E.164 digits when it parses, otherwise its
 * digits (a 10-digit number gets the US country code). Null when blank or too
 * short to be a number.
 */
export function duplicatePhoneKey(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  try {
    const e164 = normalizeE164(v);
    if (e164) return e164.replace(/\D/g, '');
  } catch {
    // Not a valid number. Fall back to its digits, so two identical typos still match.
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;
  return digits.length === 10 ? `1${digits}` : digits;
}

/** The comparable form of an email: trimmed and lower-cased. Null when blank or missing an @. */
export function duplicateEmailKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t.includes('@') ? t : null;
}

export interface DuplicateContact {
  phoneNumber?: unknown;
  email?: unknown;
}

/** What two households share, or null when neither the phone nor the email matches. */
export function duplicateMatch(a: DuplicateContact, b: DuplicateContact): DuplicateMatch | null {
  const phoneA = duplicatePhoneKey(a.phoneNumber);
  const emailA = duplicateEmailKey(a.email);
  const phone = phoneA !== null && phoneA === duplicatePhoneKey(b.phoneNumber);
  const email = emailA !== null && emailA === duplicateEmailKey(b.email);
  if (phone && email) return 'phone and email';
  if (phone) return 'phone';
  if (email) return 'email';
  return null;
}
