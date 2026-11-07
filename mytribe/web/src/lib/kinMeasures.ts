/**
 * Age and weight on a Kin, checked the same way on every client and on the
 * server (#1583).
 *
 * Age is a number of YEARS (the screens print it as "5 yrs", so "abc-5" used to
 * read "abc-5 yrs"). Weight is a number with an optional unit.
 *
 * Both are optional: a blank is "not recorded" and always valid.
 *
 * LEGACY VALUES. Records already on file may hold text that fails these rules.
 * They still load and still display, and a save that leaves the field alone
 * must not be refused over it, so the validators take the value the record had
 * when it loaded and accept it unchanged. Only a field the user edits is held
 * to the rule. The admin web (`auntieos-admin/src/lib/kinMeasures.ts`), the Kotlin clients
 * (`KinMeasures.kt`), the functions (`lib/kinMeasures.ts`) and `firestore.rules`
 * carry the same rule; change them together.
 */
/** Most years an age may name. A generous ceiling, not a business value. */
export const KIN_AGE_MAX_YEARS = 100;
/** Largest weight, in whatever unit the user typed. */
export const KIN_WEIGHT_MAX = 9999;
/** Units a weight may carry. Matched case-insensitively. */
export const KIN_WEIGHT_UNITS = ['lb', 'lbs', 'kg', 'oz', 'g'] as const;
const AGE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const WEIGHT_PATTERN = /^(\d{1,4}(?:\.\d{1,2})?)\s?(lb|lbs|kg|oz|g)?$/i;
export const KIN_AGE_MESSAGE = `Age is a number of years, like 5 or 0.5 (up to ${KIN_AGE_MAX_YEARS}).`;
export const KIN_WEIGHT_MESSAGE = `Weight is a number with an optional unit (lb, kg, oz or g), like 45 lb or 12.5 kg.`;
function isUnchanged(raw: string, original: string | undefined): boolean {
  return original !== undefined && raw.trim() === original.trim();
}

/** Null when the age is acceptable, else the message to show. */
export function validateKinAge(raw: string, original?: string): string | null {
  const v = raw.trim();
  if (v === '' || isUnchanged(v, original)) return null;
  if (!AGE_PATTERN.test(v)) return KIN_AGE_MESSAGE;
  return Number(v) > KIN_AGE_MAX_YEARS ? KIN_AGE_MESSAGE : null;
}

/** Null when the weight is acceptable, else the message to show. */
export function validateKinWeight(raw: string, original?: string): string | null {
  const v = raw.trim();
  if (v === '' || isUnchanged(v, original)) return null;
  const m = WEIGHT_PATTERN.exec(v);
  if (m === null) return KIN_WEIGHT_MESSAGE;
  const n = Number(m[1]);
  return n > 0 && n <= KIN_WEIGHT_MAX ? null : KIN_WEIGHT_MESSAGE;
}
