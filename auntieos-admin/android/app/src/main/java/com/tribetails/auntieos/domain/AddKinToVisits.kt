package com.tribetails.auntieos.domain

/**
 * #1822 (operator ruling 2026-11-20): "Add <Kin> to the N upcoming visits".
 *
 * A Kin adopted after visits were booked is on every visit booked from then
 * on; the visits already booked keep their Kin. The owner can put the Kin on
 * the household's upcoming visits too (`addKinToUpcomingVisits`). The server
 * decides which visits count (not started, start still ahead) and refuses an
 * Auntie. Pure, so the wording is tested without a screen. The web mirror is
 * auntieos-admin/src/components/AddKinToUpcomingVisits.tsx.
 */

/** The callable's answer. */
data class AddKinToVisitsAnswer(
    /** The id the visits store for the Kin. */
    val kinId: String,
    val kinName: String?,
    /** Upcoming visits that do not carry the Kin yet. */
    val upcoming: Int,
    /** Visits the call changed (0 for a preview). */
    val added: Int,
)

private fun countOf(v: Any?): Int = when (v) {
    is Int -> v.coerceAtLeast(0)
    is Long -> v.toInt().coerceAtLeast(0)
    is Double -> if (v % 1.0 == 0.0 && v >= 0) v.toInt() else 0
    else -> 0
}

/** Null when the answer is not a success. */
fun addKinToVisitsAnswerOf(raw: Map<String, Any?>?): AddKinToVisitsAnswer? {
    if (raw?.get("ok") != true) return null
    val kinId = (raw["kinId"] as? String)?.takeIf { it.isNotBlank() } ?: return null
    return AddKinToVisitsAnswer(
        kinId = kinId,
        kinName = (raw["kinName"] as? String)?.takeIf { it.isNotBlank() },
        upcoming = countOf(raw["upcoming"]),
        added = countOf(raw["added"]),
    )
}

/** "Add Pepper to the 3 upcoming visits", or "the upcoming visit" for one. */
fun addKinToVisitsLabel(name: String, count: Int): String =
    if (count == 1) "Add $name to the upcoming visit" else "Add $name to the $count upcoming visits"

/** "Pepper is not on 3 upcoming visits." */
fun kinMissingFromVisitsLine(name: String, count: Int): String =
    if (count == 1) "$name is not on 1 upcoming visit." else "$name is not on $count upcoming visits."

/** The confirm's sentence. */
fun addKinToVisitsConfirmLine(name: String, count: Int): String =
    (if (count == 1) {
        "$name will be on the upcoming visit already booked for this household."
    } else {
        "$name will be on the $count upcoming visits already booked for this household."
    }) + " Visits that have started or are over stay as they are."

/** "Added Pepper to 3 upcoming visits." */
fun addedKinToVisitsLine(name: String, count: Int): String = when (count) {
    0 -> "$name is already on every upcoming visit."
    1 -> "Added $name to 1 upcoming visit."
    else -> "Added $name to $count upcoming visits."
}
