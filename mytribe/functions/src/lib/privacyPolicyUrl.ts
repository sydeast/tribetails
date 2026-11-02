/**
 * `business_settings.privacyPolicyUrl` (#1410): the link the email footer
 * (#1399) and the portal About screen will show. The field is optional until
 * the operator sets one, so blank is a legal, meaningful value: "no policy
 * published yet", and the readers simply omit the link.
 *
 * ONE PREDICATE, FIVE COPIES. A value is acceptable when, trimmed, it is empty
 * OR it starts with `https://`, names a host, carries no whitespace or markup
 * character, and is at most [PRIVACY_POLICY_URL_MAX_LENGTH] characters. The
 * same sentence is implemented in `firestore.rules` (`bsHttpsUrl`), the React
 * admin (`auntieos-admin/src/lib/privacyPolicyUrl.ts`), admin Android
 * (`data/model/PrivacyPolicyUrl.kt`) and the desktop console
 * (`screens/settings/PrivacyPolicyUrl.kt`). Change all of them together or none.
 *
 * WHY THE SERVER CHECKS ON READ. The three admin clients write the settings
 * document directly and the rules are the only write gate, but a hand edit in
 * the Firestore console goes around them, and this value ends up inside an
 * `href`. So [readPrivacyPolicyUrl] returns the stored value only when it
 * passes, and blank otherwise: a reader never has to decide whether a stored
 * string is safe to link. The character set is the one `isSafeHtmlUrl` in
 * `lib/email.ts` accepts for an unescaped html merge value, so a URL this
 * module hands out is one the email renderer will treat as a link rather than
 * as text. Deliberately not imported from there: `email.ts` carries the smtp
 * transport and its guards, and a portal read has no business loading them.
 */

/** Generous for a real policy URL, and a ceiling so a client cannot store a novel. */
export const PRIVACY_POLICY_URL_MAX_LENGTH = 2048;

/**
 * `https://`, a host (no `/`, `?` or `#` in it), then anything without
 * whitespace, quote, angle bracket, backtick or backslash. The host group is
 * what refuses `https:///privacy`, which WHATWG URL parsing would otherwise
 * read as a host named "privacy".
 */
const HTTPS_URL = /^https:\/\/[^\s/?#"'<>`\\]+[^\s"'<>`\\]*$/;

/** True for blank, and for a plain https URL with a host within the length cap. */
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
 * The stored `privacyPolicyUrl` as a reader may use it: the trimmed value when
 * it passes [isValidPrivacyPolicyUrl], blank when the key is absent, not a
 * string, or fails the check.
 */
export function readPrivacyPolicyUrl(settings: Record<string, unknown>): string {
  const raw = settings['privacyPolicyUrl'];
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return isValidPrivacyPolicyUrl(trimmed) ? trimmed : '';
}
