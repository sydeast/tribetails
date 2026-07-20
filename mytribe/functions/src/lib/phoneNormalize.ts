import { parsePhoneNumberFromString, isValidPhoneNumber } from 'libphonenumber-js';

/**
 * Normalize a user-supplied phone string to E.164 (`+15551234567`).
 *
 * Behavior:
 *   - Empty / null / undefined → returns null (caller clears the field).
 *   - Valid number → returns E.164.
 *   - Already-E.164 numbers pass through after re-parse (acts as a sanity check).
 *   - Numbers without country code → assumes `defaultCountry` (defaults to 'US').
 *   - Invalid number → throws so the caller surfaces the error instead of
 *     silently writing a malformed phone (fail-loud policy).
 *
 * The downstream SMS channel (Twilio) requires E.164, saving anything else
 * makes the failure show up only at send time, far from the input.
 */
export function normalizeE164(input: string | null | undefined, defaultCountry: 'US' | 'CA' | 'GB' | 'AU' = 'US'): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw new Error(`phoneNormalize: '${trimmed}' is not a valid phone number`);
  }
  return parsed.number;
}

/** Cheap pre-validate without throwing, useful in zod refinements. */
export function isValidPhone(input: string, defaultCountry: 'US' | 'CA' | 'GB' | 'AU' = 'US'): boolean {
  return isValidPhoneNumber(input, defaultCountry);
}
