package com.tribetails.auntieos.ui.admin

/**
 * What a visit's service is CALLED, resolved against the operator's KinCare
 * catalog (#1592: the Schedule legend and KinTales rows printed `visit_60`, and
 * Bookings printed `30minute`). Port of the web `bookingServiceName`
 * (`auntieos-admin/src/lib/bookingFormat.ts`); the two must agree.
 *
 * `kin_care_sessions.serviceType` is free text holding several spellings of the
 * same few services (`visit_60`, `60Mins`, `30 Minute`, `30Minute`). In order:
 *  1. The catalog key itself, matched on letters and digits alone.
 *  2. The one catalog entry that runs as long as the label states, when exactly
 *     one does (a bare trailing number is read as minutes, the `visit_60`
 *     shape). Two 60-minute KinCares resolve to nothing rather than a guess.
 *
 * Unresolved falls back to the stored text, never a placeholder; only a blank
 * field becomes "Visit". The name returned is the catalog KEY, which is what the
 * KinCare settings and the booking picker show.
 */
fun bookingServiceName(
    rawServiceType: String?,
    serviceRates: Map<String, String>,
    serviceDurations: Map<String, String> = emptyMap(),
): String {
    val label = rawServiceType?.trim().orEmpty()
    if (label.isEmpty()) return "Visit"
    val keys = serviceRates.keys.map { it.trim() }.filter { it.isNotEmpty() }
    val wanted = normaliseServiceKey(label)
    keys.firstOrNull { normaliseServiceKey(it) == wanted }?.let { return it }
    val minutes = labelMinutes(label)
    if (minutes != null) {
        val sameLength = keys.filter {
            (storedDurationMinutes(serviceDurations[it]) ?: serviceDurationMinutes(it)) == minutes
        }
        if (sameLength.size == 1) return sameLength.first()
    }
    return label
}

/** Letters and digits only, lowercased: "30 Minute", "30Minute" and "30-minute" are one id. */
private fun normaliseServiceKey(raw: String): String = raw.lowercase().replace(Regex("[^a-z0-9]"), "")

private val BARE_TRAILING_NUMBER = Regex("""(?:^|[^0-9A-Za-z])(\d{1,4})$""")

/** Minutes a label states: a stated unit wins, else a bare trailing number. */
private fun labelMinutes(label: String): Int? {
    serviceDurationMinutes(label)?.let { return it }
    val bare = BARE_TRAILING_NUMBER.find(label) ?: return null
    val minutes = bare.groupValues[1].toInt()
    return if (minutes > 0) minutes else null
}
