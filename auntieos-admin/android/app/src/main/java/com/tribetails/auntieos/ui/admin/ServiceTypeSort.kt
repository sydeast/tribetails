package com.tribetails.auntieos.ui.admin

private val DURATION_RE =
    Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)

/**
 * Minutes stated inside a service NAME: "45Minute" -> 45, "1Hr" -> 60,
 * "Half-Day 6Hrs" -> 360. Null when the name states no duration.
 *
 * This is the FALLBACK source. `business_settings.serviceDurations` is the
 * operator stating the length outright, keyed by the same name, and it wins
 * whenever it is present; the parse below covers every type saved before that
 * field existed, which today is all of them. The LARGEST match wins, so a
 * compound name reads as its real length rather than as whichever number
 * appeared first.
 */
fun serviceDurationMinutes(name: String): Int? =
    DURATION_RE.findAll(name)
        .map { mr -> mr.groupValues[1].toInt().let { n -> if (mr.groupValues[2].startsWith("h", true)) n * 60 else n } }
        .maxOrNull()

/**
 * B9 (A8): order service-type LABELS by the duration embedded in the name
 * ("45 Minute" < "1 Hr" < "2 Hours"), shortest first, so pickers and the schedule
 * legend read in a sensible order instead of map/insertion order. Labels with no
 * parseable duration sort last, keeping their input order (sortedBy is stable).
 * Pure mirror of the web sortServiceTypesByDuration — see ServiceTypeSortTest.
 */
fun sortServiceTypesByDuration(types: List<String>): List<String> =
    types.sortedBy { serviceDurationMinutes(it) ?: Int.MAX_VALUE }

/**
 * Minutes off a stored `serviceDurations` value, or null when there is nothing
 * usable there.
 *
 * Null rather than 0 on junk, so a mistyped duration falls through to the name
 * parse instead of declaring the service instantaneous. Zero and negatives are
 * refused for the same reason: a visit with no length is not a length. Mirrors
 * the web `storedDurationMinutes`.
 */
fun storedDurationMinutes(raw: String?): Int? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val minutes = trimmed.toDoubleOrNull() ?: return null
    if (!minutes.isFinite() || minutes <= 0) return null
    return Math.round(minutes).toInt()
}
/**
 * One pickable service, derived from a single `serviceRates` entry. Mirrors the
 * web `ServiceOption` (auntieos-admin/src/lib/newBooking.ts) field for field.
 */
data class ServiceOption(
    /** The map KEY, trimmed. This is the canonical name sent to the callable. */
    val name: String,
    /** The rate exactly as the operator typed it; "" when they left it unset. */
    val rate: String,
    /** Stored minutes if the operator gave any, else parsed out of [name], else null. */
    val durationMinutes: Int?,
)

/**
 * Reads the operator's KinCare types (`business_settings.serviceRates`) into
 * duration-ordered options. Blank keys are dropped (unsaveable in Settings,
 * unpickable here); a blank RATE is kept, because Settings allows one and a
 * configured service must not vanish from the booking dialog just because its
 * price is still blank.
 */
fun serviceOptionsFromRates(
    rates: Map<String, String>,
    durations: Map<String, String> = emptyMap(),
): List<ServiceOption> =
    rates.entries
        .map { (key, rate) ->
            ServiceOption(
                key.trim(),
                rate.trim(),
                storedDurationMinutes(durations[key]) ?: serviceDurationMinutes(key),
            )
        }
        .filter { it.name.isNotEmpty() }
        .sortedBy { it.durationMinutes ?: Int.MAX_VALUE }
/**
 * Order service-type LABELS the same way, with the stored durations consulted
 * first. The [sortServiceTypesByDuration] overload above stays for callers that
 * hold only a list of names.
 */
fun sortServiceTypesByDuration(types: List<String>, durations: Map<String, String>): List<String> =
    types.sortedBy { storedDurationMinutes(durations[it]) ?: serviceDurationMinutes(it) ?: Int.MAX_VALUE }

/** Picker text: "30Minute · $25", or just the name when no rate is set. */
fun serviceChipLabel(option: ServiceOption): String =
    if (option.rate.isEmpty()) option.name else "${option.name} · $${option.rate}"
