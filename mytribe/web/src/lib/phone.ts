/**
 * Phone display and pre-submit checks shared by every portal screen (#1306,
 * #1289). The Kotlin twin is `util/PhoneFormat.kt`; keep the two in step.
 *
 * The server stores E.164 (`+15125550142`). Nothing a person reads should ever
 * be that string, so every place a phone is shown or edited goes through
 * `formatPhone`.
 */
/** What a household reads for a number the form can already see is wrong. */
export const PHONE_PROBLEM = 'Enter a 10-digit phone number.';
function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
}
/** The ten US digits in `raw`, or null when it is not a US number. */
function usDigits(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = digitsOf(trimmed);
  if (digits.length === 10 && !trimmed.startsWith('+')) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return null;
}
/**
 * `(512) 555-0142` for a US number in any common shape (`+15125550142`,
 * `5125667512`, `512-555-0142`). Anything else, international numbers included,
 * comes back as typed: guessing a grouping for a country we do not know would
 * be worse than leaving it alone.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const us = usDigits(trimmed);
  if (!us) return trimmed;
  return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
}
/**
 * A plain message when `raw` cannot be a phone number, else null. Empty is fine
 * (the field is optional). This is deliberately a floor, not the rule: the
 * server's libphonenumber check has the last word, and a number this lets
 * through can still be refused there with the same sentence.
 */
export function phoneProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/[^\d\s()+.-]/.test(trimmed)) return PHONE_PROBLEM;
  const digits = digitsOf(trimmed);
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? null : PHONE_PROBLEM;
  if (digits.length === 10) return null;
  if (digits.length === 11 && digits.startsWith('1')) return null;
  return PHONE_PROBLEM;
}
