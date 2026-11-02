/**
 * `business_settings.businessName` (#1409), as the Business profile panel
 * checks it before Save. Ruling 2026-11-01 on #1369: the business name is
 * required. The one predicate every layer mirrors: trimmed, the value has at
 * least one character. `firestore.rules` (`bsNonBlankString`) is the floor
 * under this; admin Android (`data/model/BusinessName.kt`) and the desktop
 * console (`screens/settings/BusinessName.kt`) carry the same check beside
 * their fields. Change all of them together or none.
 *
 * The "your Auntie" fallbacks the household copy uses when no name is stored
 * (`functions/src/lib/businessName.ts`, the portals' `businessLabel`) stay in
 * place as dead-path safety; this check is what makes them unreachable from an
 * admin editor, not a replacement for them.
 */

export const BUSINESS_NAME_REQUIRED_MESSAGE = 'Enter the business name.';

/** True when the trimmed value has at least one character. */
export function isValidBusinessName(value: string): boolean {
  return value.trim() !== '';
}

/**
 * What to say beside the field, or null when the typed value may be saved.
 * Checks the trimmed value, since that is what Save writes.
 */
export function businessNameError(value: string): string | null {
  return isValidBusinessName(value) ? null : BUSINESS_NAME_REQUIRED_MESSAGE;
}
