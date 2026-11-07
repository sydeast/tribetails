/**
 * Age and weight on a Kin, checked the same way on every client and here
 * (#1583). Mirrors admin web `src/lib/kinMeasures.ts`, the Android and desktop
 * `KinMeasures.kt`, and the `kinAgeOk` / `kinWeightOk` helpers in
 * `firestore.rules`; change them together.
 *
 * Age is a number of YEARS. Weight is a number with an optional unit. Both are
 * optional: blank is "not recorded".
 *
 * LEGACY VALUES. A record may already hold free text that fails these rules.
 * It still loads and a write that leaves the field alone is never refused, so
 * the validators take the value the record already had and accept it unchanged.
 */
export const KIN_AGE_MAX_YEARS = 100;
export const KIN_WEIGHT_MAX = 9999;
export const KIN_AGE_MESSAGE = `Age is a number of years, like 5 or 0.5 (up to ${KIN_AGE_MAX_YEARS}).`;
export const KIN_WEIGHT_MESSAGE =
  'Weight is a number with an optional unit (lb, kg, oz or g), like 45 lb or 12.5 kg.';
const AGE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const WEIGHT_PATTERN = /^(\d{1,4}(?:\.\d{1,2})?)\s?(lb|lbs|kg|oz|g)?$/i;
function unchanged(raw: string, original: string | null | undefined): boolean {
  return typeof original === 'string' && raw.trim() === original.trim();
}

/** Null when the age string is acceptable, else the message. */
export function validateKinAge(raw: string, original?: string | null): string | null {
  const v = raw.trim();
  if (v === '' || unchanged(v, original)) return null;
  if (!AGE_PATTERN.test(v)) return KIN_AGE_MESSAGE;
  return Number(v) > KIN_AGE_MAX_YEARS ? KIN_AGE_MESSAGE : null;
}

/** Null when the weight string is acceptable, else the message. */
export function validateKinWeight(raw: string, original?: string | null): string | null {
  const v = raw.trim();
  if (v === '' || unchanged(v, original)) return null;
  const m = WEIGHT_PATTERN.exec(v);
  if (m === null) return KIN_WEIGHT_MESSAGE;
  const n = Number(m[1]);
  return n > 0 && n <= KIN_WEIGHT_MAX ? null : KIN_WEIGHT_MESSAGE;
}
