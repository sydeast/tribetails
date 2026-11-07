package com.kinfolk.portal.screens.kin
/**
 * Age and weight on a Kin, checked the same way on every client and on the
 * server (#1583). Mirrors admin web `lib/kinMeasures.ts`, the admin Android and
 * desktop `KinMeasures.kt`, the functions' `lib/kinMeasures.ts` and the
 * `firestore.rules` helpers; change them together.
 *
 * The portal age box already takes whole years only (digits), so it needs only
 * the ceiling; weight is a number with an optional unit. A value the pet already
 * carries passes unchanged, so old free text never blocks an edit.
 */
internal const val KIN_AGE_MAX_YEARS = 100
internal const val KIN_WEIGHT_MAX = 9999
internal const val KIN_AGE_MESSAGE = "Age is a number of years, 0 to $KIN_AGE_MAX_YEARS."
internal const val KIN_WEIGHT_MESSAGE = "Weight is a number with an optional unit (lb, kg, oz or g), like 45 lb or 12.5 kg."
private val WEIGHT_PATTERN = Regex("""^(\d{1,4}(?:\.\d{1,2})?)\s?(lb|lbs|kg|oz|g)?$""", RegexOption.IGNORE_CASE)
/** Null when the age text is acceptable, else the message. [original] is the text the pet loaded with. */
internal fun validateKinAgeText(raw: String, original: String? = null): String? {
    val v = raw.trim()
    if (v.isEmpty() || (original != null && v == original.trim())) return null
    val n = v.toIntOrNull() ?: return KIN_AGE_MESSAGE
    return if (n in 0..KIN_AGE_MAX_YEARS) null else KIN_AGE_MESSAGE
}

/** Null when the weight is acceptable, else the message. [original] is the weight the pet loaded with. */
internal fun validateKinWeight(raw: String, original: String? = null): String? {
    val v = raw.trim()
    if (v.isEmpty() || (original != null && v == original.trim())) return null
    val m = WEIGHT_PATTERN.matchEntire(v) ?: return KIN_WEIGHT_MESSAGE
    val n = m.groupValues[1].toDouble()
    return if (n > 0 && n <= KIN_WEIGHT_MAX) null else KIN_WEIGHT_MESSAGE
}
