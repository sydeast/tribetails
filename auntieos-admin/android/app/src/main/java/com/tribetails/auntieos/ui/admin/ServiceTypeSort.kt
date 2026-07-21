package com.tribetails.auntieos.ui.admin

/**
 * B9 (A8): order service-type LABELS by the duration embedded in the name
 * ("45 Minute" < "1 Hr" < "2 Hours"), shortest first, so pickers and the schedule
 * legend read in a sensible order instead of map/insertion order. Labels with no
 * parseable duration sort last. Pure mirror of the web sortServiceTypesByDuration —
 * see ServiceTypeSortTest.
 */
fun sortServiceTypesByDuration(types: List<String>): List<String> {
    val re = Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)
    fun minutes(label: String): Int =
        re.findAll(label)
            .map { mr -> mr.groupValues[1].toInt().let { n -> if (mr.groupValues[2].startsWith("h", true)) n * 60 else n } }
            .maxOrNull() ?: Int.MAX_VALUE
    return types.sortedBy { minutes(it) }
}
