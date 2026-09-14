package com.tribetails.auntieos.web.data

import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * What the server decided when the admin asked for an invoice reminder (#832).
 *
 * `sendInvoiceReminder` refuses a second reminder inside its window and answers
 * `sent = false` with the time of the one that already went out. That is a
 * success: the household has been reminded. The console says so, and when,
 * instead of "Reminder sent." for a send that did not happen.
 */
data class ReminderOutcome(
    /** True when THIS call sent a reminder. */
    val sent: Boolean,
    /** When the most recent reminder went out (ms epoch). */
    val lastReminderAtMs: Long,
    /** The earliest moment another reminder will be accepted (ms epoch). */
    val nextReminderAllowedAtMs: Long,
)

private val reminderJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decodes the callable body. Throws on a body that is not a JSON object, so the
 * caller's `runCatching` turns it into an Err.
 *
 * A body WITHOUT `sent` comes from a function deployed before #832, which only
 * ever answered after sending. Reading that as "not sent" would tell the admin
 * a reminder was refused when it went out, so it reads as sent, at [nowMs].
 */
fun decodeReminderOutcome(body: String, nowMs: Long): ReminderOutcome {
    val obj = reminderJson.parseToJsonElement(body).jsonObject
    val sent = obj["sent"]?.jsonPrimitive?.booleanOrNull
        ?: return ReminderOutcome(sent = true, lastReminderAtMs = nowMs, nextReminderAllowedAtMs = nowMs)
    val last = obj["lastReminderAtMs"]?.jsonPrimitive?.longOrNull ?: nowMs
    val next = obj["nextReminderAllowedAtMs"]?.jsonPrimitive?.longOrNull ?: last
    return ReminderOutcome(sent = sent, lastReminderAtMs = last, nextReminderAllowedAtMs = next)
}

@OptIn(ExperimentalTime::class)
fun reminderNowMs(): Long = Clock.System.now().toEpochMilliseconds()

private val MONTH_ABBR = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Sep 14, 3:05 PM", in [zone] (the console's own zone unless a test pins one). */
@OptIn(ExperimentalTime::class)
fun formatReminderTime(ms: Long, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    val ldt = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone)
    val month = MONTH_ABBR[ldt.date.month.ordinal]
    val hour12 = (ldt.hour % 12).let { if (it == 0) 12 else it }
    val ampm = if (ldt.hour < 12) "AM" else "PM"
    val minute = ldt.minute.toString().padStart(2, '0')
    return "$month ${ldt.date.day}, $hour12:$minute $ampm"
}

/** The notice after a press. */
fun reminderOutcomeMessage(outcome: ReminderOutcome, zone: TimeZone = TimeZone.currentSystemDefault()): String =
    if (outcome.sent) {
        "Reminder sent."
    } else {
        "Not sent: a reminder already went out ${formatReminderTime(outcome.lastReminderAtMs, zone)}. " +
            "The next one can go out after ${formatReminderTime(outcome.nextReminderAllowedAtMs, zone)}."
    }

/** The value of the "Last reminder" row. Absent, null or non-positive means none on record. */
fun lastReminderLabel(stampMs: Long?, zone: TimeZone = TimeZone.currentSystemDefault()): String =
    if (stampMs != null && stampMs > 0L) formatReminderTime(stampMs, zone) else "none sent"
