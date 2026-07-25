/**
 * "Send outside the tribe": the pre-flight and the error copy for a one-off
 * email or text to somebody who is not a kinfolk.
 *
 * ── THE PRE-FLIGHT MIRRORS THE SERVER, IT DOES NOT REPLACE IT ───────────────
 * `sendExternalMessage` and `suppressExternalRecipient` (MyTribe
 * `functions/src/admin/sendExternalMessage.ts`) are the authority. Everything
 * here exists so a doomed request never leaves the browser and the operator
 * gets a readable sentence instead of a zod path. The server still validates
 * everything it validated before.
 *
 * Email: the regex is the server's own, character for character
 * (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`). Keeping them identical is what stops the
 * two from disagreeing about an address on the boundary.
 *
 * Phone: the server uses libphonenumber-js (`isValidPhone`), which knows every
 * country's real numbering plan. This app does not carry that dependency, and
 * adding ~150kB to the admin bundle to reject a number the server will reject
 * anyway is a bad trade. So this is a deliberately WIDER shape check: E.164
 * allows 8 to 15 digits, and we accept anything in that range made of digits
 * and the punctuation people type. Wider is the correct direction for a mirror
 * to err: a number we accept and the server rejects produces a named server
 * error, whereas a number we reject and the server would have accepted is a
 * message that can never be sent and no error explains why.
 *
 * That failure is not hypothetical. The Android twin's `isValidPhone`
 * (`util/FieldValidators.kt`) is US-only (10 digits, or 11 starting with 1), so
 * it silently blocks every valid international recipient before the server sees
 * them. Task 10 of this slice fixes that; this module never had the bug.
 */

export type ExternalChannel = 'email' | 'sms';

export const EXTERNAL_CHANNELS: readonly { key: ExternalChannel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'Text' },
];

/** Verbatim copy of the server's `superRefine` email check. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits plus the punctuation an operator types. Anything else is not a phone number. */
const PHONE_CHARS = /^\+?[0-9 ()\-.]+$/;

/** E.164: a country code plus a subscriber number, 8 to 15 digits all told. */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

export function isValidExternalEmail(raw: string): boolean {
  return EMAIL_SHAPE.test(raw.trim());
}

export function isValidExternalPhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '' || !PHONE_CHARS.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '').length;
  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
}

export type RecipientValidation = 'valid' | 'empty' | 'bad-email' | 'bad-phone';

/**
 * Empty is its own answer, not a malformed address. "Add a recipient first" and
 * "that is not a valid email" are different problems and deserve different
 * sentences.
 */
export function validateExternalRecipient(channel: ExternalChannel, raw: string): RecipientValidation {
  if (raw.trim() === '') return 'empty';
  if (channel === 'email') return isValidExternalEmail(raw) ? 'valid' : 'bad-email';
  return isValidExternalPhone(raw) ? 'valid' : 'bad-phone';
}

const BAD_EMAIL_TEXT = 'That does not look like a valid email address.';
const BAD_PHONE_TEXT = 'That does not look like a valid phone number. Use the full number with country code.';

/** Why this send cannot go yet, or null. First blocking reason wins. */
export function externalSendBlocker(
  channel: ExternalChannel,
  to: string,
  subject: string,
  body: string,
): string | null {
  const recipient = validateExternalRecipient(channel, to);
  if (recipient === 'empty') return 'Add a recipient first.';
  if (recipient === 'bad-email') return BAD_EMAIL_TEXT;
  if (recipient === 'bad-phone') return BAD_PHONE_TEXT;
  if (channel === 'email' && subject.trim() === '') return 'Email needs a subject.';
  if (body.trim() === '') return 'Write a message body first.';
  return null;
}

/** Why this opt-out cannot be recorded yet, or null. Recipient only: an opt-out sends nothing. */
export function externalSuppressBlocker(channel: ExternalChannel, to: string): string | null {
  const recipient = validateExternalRecipient(channel, to);
  if (recipient === 'empty') return 'Add a recipient to opt out first.';
  if (recipient === 'bad-email') return BAD_EMAIL_TEXT;
  if (recipient === 'bad-phone') return BAD_PHONE_TEXT;
  return null;
}

/**
 * The server throws `failed-precondition` with the literal message
 * `recipient_opted_out`. A substring test, not equality: the Functions SDK
 * prefixes the code, and different platforms format that prefix differently.
 */
export function isOptedOutError(message: string): boolean {
  return message.toLowerCase().includes('recipient_opted_out');
}

/**
 * Operator-readable text for a failed external send.
 *
 * Only the opt-out sentinel is translated. Everything else passes through
 * verbatim: a provider's own words ("smtp2go rejected the sender domain") tell
 * the operator far more than any sentence we could substitute, and hiding them
 * behind "Something went wrong" is how a fixable configuration problem becomes
 * an unfixable one.
 */
export function externalSendErrorText(message: string): string {
  if (isOptedOutError(message)) {
    return 'This recipient has opted out. Nothing was sent. Remove their suppression before sending again.';
  }
  return message.trim() === '' ? 'The send failed.' : message;
}
