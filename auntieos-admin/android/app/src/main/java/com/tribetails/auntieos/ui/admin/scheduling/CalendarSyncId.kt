package com.tribetails.auntieos.ui.admin.scheduling

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Google Calendar sync: what counts as a calendar id, and how the last run reads
 * back to the operator. Pure Kotlin, no Compose, no Firebase, so both halves are
 * unit-testable without Robolectric.
 *
 * THE ID RULE IS A MIRROR, not the enforcement. The enforcing copy is
 * `mytribe/functions/src/lib/calendarSyncId.ts`, which runs on every sync no
 * matter which client asked. This copy exists so the operator hears about a typo
 * while the field is still on screen instead of after a round trip. The React
 * admin carries the third copy (`auntieos-admin/src/lib/calendarSyncId.ts`).
 * `mytribe/functions/test/callableContract.test.ts` asserts the five cases the
 * three must agree on; see CALLABLE_CONTRACT.md.
 *
 * WHY VALIDATE AT ALL. The sync hands this string to Google's free/busy query.
 * Google answers an id it cannot see with `notFound` inside a success envelope,
 * and answers a genuinely empty calendar with an empty list. Unchecked, a typo
 * and a clear calendar both arrive as "Imported 0 busy blocks". Checking the
 * shape first is what keeps "you typed it wrong" from reading as "you have
 * nothing on".
 */

/** The shape every shared Google Calendar id takes. Used in copy, never as a default value. */
const val CALENDAR_ID_EXAMPLE = "name@group.calendar.google.com"

/** The service account the operator shares the calendar with. Frozen server-side; printed here. */
const val CALENDAR_SYNC_SA_EMAIL =
    "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com"

private val CALENDAR_ID_PATTERN = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

/**
 * The operator-facing reason [raw] cannot be a calendar id, or null when it can
 * be. An id that passes may still be one the service account cannot see; that is
 * the sync's own `notFound` report, not something a text field can know.
 */
fun calendarIdProblem(raw: String): String? {
    val value = raw.trim()
    if (value.isEmpty()) {
        return "Enter the shared calendar's ID first. It looks like $CALENDAR_ID_EXAMPLE."
    }
    if (value.lowercase() == "primary") {
        return "\"primary\" means the sync service account's own calendar, which is always " +
            "empty, so every sync would import nothing and report success. Paste the shared " +
            "calendar's ID instead, the one that looks like $CALENDAR_ID_EXAMPLE."
    }
    if (!CALENDAR_ID_PATTERN.matches(value)) {
        return "\"$value\" is not a Google Calendar ID, so a sync would import nothing and look " +
            "like an empty calendar. Copy the ID from Google Calendar under Settings, Integrate " +
            "calendar. It looks like $CALENDAR_ID_EXAMPLE, or the calendar owner's email address."
    }
    return null
}

// ── The last-run receipt ─────────────────────────────────────────────────────

/**
 * What the `syncGoogleCalendarBusyEvents` callable stamped onto the
 * business_settings doc after its last run, success or failure.
 *
 * READ-ONLY on this side, and deliberately NOT a field of [
 * com.tribetails.auntieos.data.model.BusinessSettings]: android saves that model
 * back as a whole object under `SetOptions.merge()`, so carrying these fields on
 * it would let a settings screen loaded an hour ago write a stale receipt over a
 * fresher one the server had since stamped. The server is the only writer.
 */
data class CalendarSyncRun(
    val ranAt: String,
    val succeeded: Boolean,
    val imported: Int,
    val error: String,
)

/**
 * Builds the receipt from the four raw doc fields, or null when nothing has ever
 * been stamped. A doc that carries a timestamp but no recognized status reads as
 * a FAILURE: an unreadable receipt is not evidence a sync worked.
 */
fun calendarSyncRunFrom(
    ranAt: String?,
    status: String?,
    imported: Int?,
    error: String?,
): CalendarSyncRun? {
    val stamp = ranAt?.trim().orEmpty()
    if (stamp.isEmpty()) return null
    val ok = status == "ok"
    return CalendarSyncRun(
        ranAt = stamp,
        succeeded = ok,
        imported = if (ok) imported ?: 0 else 0,
        error = if (ok) "" else error.orEmpty(),
    )
}

private val RUN_STAMP_FORMAT = DateTimeFormatter.ofPattern("MM-dd HH:mm")

/**
 * ONE line describing what the last run did, in LOCAL time, matching the React
 * admin's `calendarSyncRunLabel` wording. Null when nothing has ever run, which
 * the card renders in its own words: a sync that imported nothing and a sync
 * that never happened are different facts, and conflating them is how a broken
 * integration goes on looking fine.
 */
fun calendarSyncRunLabel(run: CalendarSyncRun?): String? {
    if (run == null) return null
    val stamp = formatRunStamp(run.ranAt)
    if (!run.succeeded) return "Last run $stamp, and it failed."
    if (run.imported == 0) {
        return "Last run $stamp. No busy events in that window, so nothing was blocked out."
    }
    val blocks = if (run.imported == 1) "1 busy block" else "${run.imported} busy blocks"
    return "Last run $stamp. Imported $blocks."
}

private fun formatRunStamp(iso: String): String = try {
    RUN_STAMP_FORMAT.format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
} catch (_: Exception) {
    // A hand-edited or legacy stamp must not delete the fact that a run happened.
    "at an unreadable time"
}
