package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * What the server decided when the admin asked for an invoice reminder (#832).
 *
 * Only [sent] means a reminder went out now. [reason] names the other three,
 * none of which is an error: `recent` (one already went out inside the
 * window), `in-progress` (another press is sending one right now), and
 * `suppressed` (the household's notification settings block reminders).
 *
 * #1507: [sent] with [appOnly] means the reminder reached the household in the
 * app only. Since #1505 a household that turned off every delivery channel
 * still gets the record in their notifications list, and nothing is emailed or
 * texted. "Reminder sent." alone would read as an email that does not exist,
 * so the sentence says where it went.
 */
data class ReminderOutcome(
    /** True when THIS call sent a reminder. */
    val sent: Boolean,
    /** `sent`, `recent`, `in-progress` or `suppressed`. */
    val reason: String,
    /** When a reminder last actually went out (ms epoch), or null if none ever did. */
    val lastReminderAtMs: Long?,
    /** The earliest moment a press can send again (ms epoch), or null when waiting would not help. */
    val nextReminderAllowedAtMs: Long?,
    /** With [sent]: the reminder reached the household in the app only (#1507). Absent from an older server reads false. */
    val appOnly: Boolean = false,
)

/** #1507: the clause every app-only send carries, on every admin surface. */
const val APP_ONLY_NOTE = "Email and text are off for this household."

private val REASONS = setOf("sent", "recent", "in-progress", "suppressed")

private val reminderJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decodes the callable body. Throws on a body that is not a JSON object, so the
 * caller's `runCatchingCancellable` turns it into an Err.
 *
 * A body WITHOUT `sent` comes from a function deployed before #832, which only
 * ever answered after sending. Reading that as "not sent" would tell the admin
 * a reminder was refused when it went out, so it reads as sent, at [nowMs].
 */
fun decodeReminderOutcome(body: String, nowMs: Long): ReminderOutcome {
    val obj = reminderJson.parseToJsonElement(body).jsonObject
    val sent = obj["sent"]?.jsonPrimitive?.booleanOrNull
        ?: return ReminderOutcome(sent = true, reason = "sent", lastReminderAtMs = nowMs, nextReminderAllowedAtMs = null)
    val rawReason = obj["reason"]?.jsonPrimitive?.contentOrNull
    val reason = rawReason?.takeIf { it in REASONS } ?: if (sent) "sent" else "recent"
    return ReminderOutcome(
        sent = sent,
        reason = reason,
        lastReminderAtMs = obj["lastReminderAtMs"]?.jsonPrimitive?.longOrNull,
        nextReminderAllowedAtMs = obj["nextReminderAllowedAtMs"]?.jsonPrimitive?.longOrNull,
        // #1507: only an explicit true counts. A function deployed before #1507
        // omits the key, and so does every non-send; both read as a channel send.
        appOnly = obj["appOnly"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
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
fun reminderOutcomeMessage(outcome: ReminderOutcome, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    val next = outcome.nextReminderAllowedAtMs
    val last = outcome.lastReminderAtMs
    return when (outcome.reason) {
        "sent" -> if (outcome.appOnly) "Reminder sent in the app only. $APP_ONLY_NOTE" else "Reminder sent."
        "in-progress" ->
            "Not sent: a reminder for this invoice is already being sent." +
                (next?.let { " If it does not arrive, try again after ${formatReminderTime(it, zone)}." } ?: "")
        "suppressed" ->
            "Not sent: this household's notification settings block payment reminders, so no reminder went out."
        else ->
            (last?.let { "Not sent: a reminder already went out ${formatReminderTime(it, zone)}." }
                ?: "Not sent: a reminder already went out recently.") +
                (next?.let { " The next one can go out after ${formatReminderTime(it, zone)}." } ?: "")
    }
}

/**
 * The value of the "Last reminder" row. Absent, null or non-positive means none on record.
 *
 * #1507: [appOnly] is the companion flag the server writes beside the stamp
 * (`reminderNotifiedAppOnly`). Only an explicit true adds "app only"; a stamp
 * from before the flag existed, or one copied from the dedupe ledger, has none.
 */
fun lastReminderLabel(stampMs: Long?, zone: TimeZone = TimeZone.currentSystemDefault(), appOnly: Boolean? = false): String =
    if (stampMs != null && stampMs > 0L) formatReminderTime(stampMs, zone) + (if (appOnly == true) ", app only" else "")
    else "none sent"
