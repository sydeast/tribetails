/**
 * #1593: the email and phone shapes the admin clients check before they send,
 * so a server that uses these refuses exactly what the client already refused.
 * Mirrors: `auntieos-admin/src/lib/kinfolkEditSchema.ts` / `settingsChecks.ts`
 * (web), `util/FieldValidators.kt` (Android and desktop).
 */

/**
 * The email shape every admin client checks (`kinfolkEditSchema.ts`
 * `EMAIL_RE`, Android/desktop `FieldValidators.kt`), plus no doubled dot.
 */
const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

export function isEmailShape(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && t.length <= 254 && EMAIL_RE.test(t) && !t.includes('..');
}

/**
 * A US number the way the admin clients count it: digits and the usual
 * separators, 10 digits or 11 with a leading 1. Kept structural on purpose so
 * the client and the server agree exactly; the business number is shown, not
 * dialled by this code.
 */
export function isUsPhoneShape(raw: string): boolean {
  const t = raw.trim();
  if (t === '' || !/^[+0-9()\-. ]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

