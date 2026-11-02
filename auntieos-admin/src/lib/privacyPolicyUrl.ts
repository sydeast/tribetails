/**
 * `business_settings.privacyPolicyUrl` (#1410), as the Business profile panel
 * checks it before Save. The one predicate every layer mirrors: trimmed, the
 * value is blank (no policy published yet) OR an `https://` URL with a host, no
 * whitespace or markup character, and at most [PRIVACY_POLICY_URL_MAX_LENGTH]
 * characters. `firestore.rules` (`bsHttpsUrl`) is the floor under this, and
 * `functions/src/lib/privacyPolicyUrl.ts` is what the portal reads through;
 * admin Android and the desktop console carry the same check beside their
 * fields. Change all of them together or none.
 */

export const PRIVACY_POLICY_URL_MAX_LENGTH = 2048;

/** `https://`, a host (no `/`, `?` or `#` in it), then anything without whitespace or markup. */
const HTTPS_URL = /^https:\/\/[^\s/?#"'<>`\\]+[^\s"'<>`\\]*$/;

/** True for blank, and for a plain https URL with a host within the cap. */
export function isValidPrivacyPolicyUrl(value: string): boolean {
  if (value === '') return true;
  if (value.length > PRIVACY_POLICY_URL_MAX_LENGTH) return false;
  if (!HTTPS_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * What to say beside the field, or null when the typed value may be saved.
 * Checks the trimmed value, since that is what Save writes.
 */
export function privacyPolicyUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > PRIVACY_POLICY_URL_MAX_LENGTH) {
    return `Keep the link under ${PRIVACY_POLICY_URL_MAX_LENGTH} characters.`;
  }
  if (!isValidPrivacyPolicyUrl(trimmed)) return 'Enter a full https:// link.';
  return null;
}
