package com.tribetails.auntieos.domain

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * What the server decided when the admin asked for an invoice reminder (#832).
 *
 * Only [sent] means a reminder went out now. [reason] names the other three,
 * none of which is an error: `recent` (one already went out inside the
 * window), `in-progress` (another press is sending one right now), and
 * `suppressed` (the household's notification settings block reminders).
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
)

/** The four reasons the server answers with. */
val REMINDER_REASONS: Set<String> = setOf("sent", "recent", "in-progress", "suppressed")

/** "Sep 14, 3:05 PM", in [zone] (the device's own zone unless a test pins one). */
fun formatReminderTime(ms: Long, zone: TimeZone = TimeZone.getDefault()): String =
    SimpleDateFormat("MMM d, h:mm a", Locale.US).apply { timeZone = zone }.format(Date(ms))

/** The toast or banner line after a press. */
fun reminderOutcomeMessage(outcome: ReminderOutcome, zone: TimeZone = TimeZone.getDefault()): String {
    val next = outcome.nextReminderAllowedAtMs
    val last = outcome.lastReminderAtMs
    return when (outcome.reason) {
        "sent" -> "Reminder sent."
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

/** The value of the "Last reminder" row. Absent, null or non-positive means none on record. */
fun lastReminderLabel(stampMs: Long?, zone: TimeZone = TimeZone.getDefault()): String =
    if (stampMs != null && stampMs > 0L) formatReminderTime(stampMs, zone) else "none sent"
