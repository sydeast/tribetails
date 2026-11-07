package com.tribetails.auntieos.web.data
/**
 * Age and weight on a Kin, checked the same way on every client and on the
 * server (#1583). Mirrors web `lib/kinMeasures.ts`, the functions'
 * `lib/kinMeasures.ts`, the Android `domain/KinMeasures.kt` and the
 * `firestore.rules` helpers; change them together.
 *
 * Age is a number of YEARS (the screens print "5 yrs"). Weight is a number with
 * an optional unit. Both are optional: blank is "not recorded".
 *
 * LEGACY VALUES. A record may already hold free text that fails these rules. It
 * still loads and displays, and a save that leaves the field alone is never
 * refused, so every validator takes the value the record had when it loaded and
 * accepts it unchanged. Only an edited field is held to the rule.
 */
const val KIN_AGE_MAX_YEARS = 100
const val KIN_WEIGHT_MAX = 9999
const val KIN_AGE_MESSAGE = "Age is a number of years, like 5 or 0.5 (up to $KIN_AGE_MAX_YEARS)."
const val KIN_WEIGHT_MESSAGE = "Weight is a number with an optional unit (lb, kg, oz or g), like 45 lb or 12.5 kg."
private val AGE_PATTERN = Regex("""^\d{1,3}(\.\d{1,2})?$""")
private val WEIGHT_PATTERN = Regex("""^(\d{1,4}(?:\.\d{1,2})?)\s?(lb|lbs|kg|oz|g)?$""", RegexOption.IGNORE_CASE)
private fun unchanged(raw: String, original: String?): Boolean =
    original != null && raw.trim() == original.trim()
/** Null when the age is acceptable, else the message to show. */
fun validateKinAge(raw: String, original: String? = null): String? {
    val v = raw.trim()
    if (v.isEmpty() || unchanged(v, original)) return null
    if (!AGE_PATTERN.matches(v)) return KIN_AGE_MESSAGE
    return if (v.toDouble() > KIN_AGE_MAX_YEARS) KIN_AGE_MESSAGE else null
}

/** Null when the weight is acceptable, else the message to show. */
fun validateKinWeight(raw: String, original: String? = null): String? {
    val v = raw.trim()
    if (v.isEmpty() || unchanged(v, original)) return null
    val m = WEIGHT_PATTERN.matchEntire(v) ?: return KIN_WEIGHT_MESSAGE
    val n = m.groupValues[1].toDouble()
    return if (n > 0 && n <= KIN_WEIGHT_MAX) null else KIN_WEIGHT_MESSAGE
}
