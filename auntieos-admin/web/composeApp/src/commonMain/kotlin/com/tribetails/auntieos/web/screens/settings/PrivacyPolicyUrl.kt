package com.tribetails.auntieos.web.screens.settings

/**
 * `business_settings.privacyPolicyUrl` (#1410), as the Business Profile panel
 * checks it before Save. The one predicate every layer mirrors: trimmed, the
 * value is blank (no policy published yet) OR an `https://` URL with a host, no
 * whitespace or markup character, and at most [PRIVACY_POLICY_URL_MAX_LENGTH]
 * characters. `firestore.rules` (`bsHttpsUrl`) is the floor under this, the
 * React admin (`lib/privacyPolicyUrl.ts`) and admin Android
 * (`data/model/PrivacyPolicyUrl.kt`) carry the same check, and
 * `functions/src/lib/privacyPolicyUrl.ts` is what the portal reads through.
 * Change all of them together or none.
 */
const val PRIVACY_POLICY_URL_MAX_LENGTH = 2048

/** `https://`, a host (no `/`, `?` or `#` in it), then anything without whitespace or markup. */
private val HTTPS_URL = Regex("""^https://[^\s/?#"'<>`\\]+[^\s"'<>`\\]*$""")

/** True for blank, and for a plain https URL with a host within the cap. */
fun isValidPrivacyPolicyUrl(value: String): Boolean =
    value.isEmpty() || (value.length <= PRIVACY_POLICY_URL_MAX_LENGTH && HTTPS_URL.matches(value))

/**
 * What to say beside the field, or null when the typed value may be saved.
 * Checks the trimmed value, since that is what Save writes.
 */
fun privacyPolicyUrlError(value: String): String? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return null
    if (trimmed.length > PRIVACY_POLICY_URL_MAX_LENGTH) {
        return "Keep the link under $PRIVACY_POLICY_URL_MAX_LENGTH characters."
    }
    if (!isValidPrivacyPolicyUrl(trimmed)) return "Enter a full https:// link."
    return null
}
