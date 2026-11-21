package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * #1822 (operator ruling 2026-11-20): "Add <Kin> to the N upcoming visits".
 *
 * A Kin adopted after visits were booked is on every visit booked from then
 * on; the visits already booked keep their Kin. The owner can put the Kin on
 * the household's upcoming visits too (`addKinToUpcomingVisits`). The server
 * decides which visits count (not started, start still ahead) and refuses an
 * Auntie. Same wording as admin web (`AddKinToUpcomingVisits.tsx`) and admin
 * Android (`domain/AddKinToVisits.kt`).
 */
data class AddKinToVisitsAnswer(
    /** The id the visits store for the Kin. */
    val kinId: String,
    val kinName: String?,
    /** Upcoming visits that do not carry the Kin yet. */
    val upcoming: Int,
    /** Visits the call changed (0 for a preview). */
    val added: Int,
)

private val answerJson = Json { ignoreUnknownKeys = true }

private fun countIn(o: JsonObject, key: String): Int {
    val d = runCatching { o[key]?.jsonPrimitive?.doubleOrNull }.getOrNull() ?: return 0
    return if (d >= 0 && d % 1.0 == 0.0) d.toInt() else 0
}

/** Null when the answer is not a success. */
fun addKinToVisitsAnswerOf(raw: String): AddKinToVisitsAnswer? {
    val o = runCatching { answerJson.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return null
    if (runCatching { o["ok"]?.jsonPrimitive?.booleanOrNull }.getOrNull() != true) return null
    val kinId = runCatching { o["kinId"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() } ?: return null
    val name = runCatching { o["kinName"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }
    return AddKinToVisitsAnswer(kinId, name, countIn(o, "upcoming"), countIn(o, "added"))
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
