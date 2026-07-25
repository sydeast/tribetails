package com.tribetails.auntieos.ui.admin

private val DURATION_RE =
    Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)

/**
 * Minutes stated inside a service NAME: "45Minute" -> 45, "1Hr" -> 60,
 * "Half-Day 6Hrs" -> 360. Null when the name states no duration.
 *
 * There is no duration field on `business_settings.serviceRates` — that map is
 * name -> rate-in-dollars-as-string — so the duration has to be parsed out of the
 * name. The LARGEST match wins, so a compound name reads as its real length
 * rather than as whichever number appeared first.
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
 * One pickable service, derived from a single `serviceRates` entry. Mirrors the
 * web `ServiceOption` (auntieos-admin/src/lib/newBooking.ts) field for field.
 */
data class ServiceOption(
    /** The map KEY, trimmed. This is the canonical name sent to the callable. */
    val name: String,
    /** The rate exactly as the operator typed it; "" when they left it unset. */
    val rate: String,
    /** Minutes parsed out of [name]; null when the name states no duration. */
    val durationMinutes: Int?,
)

/**
 * Reads the operator's KinCare types (`business_settings.serviceRates`) into
 * duration-ordered options. Blank keys are dropped (unsaveable in Settings,
 * unpickable here); a blank RATE is kept, because Settings allows one and a
 * configured service must not vanish from the booking dialog just because its
 * price is still blank.
 */
fun serviceOptionsFromRates(rates: Map<String, String>): List<ServiceOption> =
    rates.entries
        .map { (key, rate) -> ServiceOption(key.trim(), rate.trim(), serviceDurationMinutes(key)) }
        .filter { it.name.isNotEmpty() }
        .sortedBy { it.durationMinutes ?: Int.MAX_VALUE }

/** Picker text: "30Minute · $25", or just the name when no rate is set. */
fun serviceChipLabel(option: ServiceOption): String =
    if (option.rate.isEmpty()) option.name else "${option.name} · $${option.rate}"
