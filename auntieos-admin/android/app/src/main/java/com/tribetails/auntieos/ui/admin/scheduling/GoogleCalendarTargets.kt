package com.tribetails.auntieos.ui.admin.scheduling

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Google Calendar over OAuth (Task 7.2): the write-target rule, the connection
 * projection, and the last-push receipt. Pure Kotlin, no Compose, no Firebase,
 * so all three are unit-testable without Robolectric, same posture as
 * `CalendarSyncId.kt` next to this file for Task 7.1.
 *
 * A DIFFERENT FEATURE from that file, sharing nothing but the word calendar.
 * 7.1 READS free/busy off a shared calendar as a service account. This one
 * WRITES visits onto a calendar belonging to a Google account the operator
 * signs into over OAuth, which is why its write-target rule is not the same
 * rule and must not be confused with it.
 *
 * THE RULE HERE IS A MIRROR, not the enforcement. The enforcing copy is
 * `mytribe/functions/src/lib/googleCalendarTargets.ts`, which runs on every
 * `setGoogleCalendarTargets` and `pushVisitsToGoogleCalendar` call no matter
 * which client asked. This copy exists so the operator hears about a bad pick
 * while the picker is still on screen instead of after a round trip. The React
 * admin carries the third copy, `auntieos-admin/src/lib/googleCalendarTargets.ts`.
 * `mytribe/functions/test/callableContract.test.ts` asserts the six cases the
 * three must agree on; see `CALLABLE_CONTRACT.md`.
 *
 * WHY `primary` IS LEGAL HERE AND REFUSED IN `CalendarSyncId.kt`. That refusal
 * is about a DIFFERENT identity: under the free/busy service account, `primary`
 * names the sync robot's own calendar, which nobody ever puts an event on, so
 * it would "succeed" forever while importing nothing. Under this OAuth
 * connection, `primary` names the calendar of the Google account the operator
 * just consented with, which is the operator's own real, writable calendar and
 * a perfectly sensible place to put visits. Same literal, two different
 * calendars, because the two features authenticate as two different accounts.
 *
 * THE ECHO LOOP, AND WHY IT IS REFUSED RATHER THAN DETECTED. The write target
 * must not be the calendar the free/busy sync imports FROM. Writing our visits
 * into that calendar would feed them straight back to us: every visit pushed
 * here becomes, on its own hour, a BLOCKED slot the free/busy sync reads back
 * in, so the Schedule shows the same hour twice, once as a booking and once as
 * imported unavailability. There is no way to catch this after the fact either:
 * `freebusy.query` returns only `start` and `end`, nothing that could mark an
 * event as one of ours, so an imported busy block can never be traced back to
 * the visit that produced it and filtered out on the way in. Refusing the
 * overlap before the pick is saved is the only guard that works.
 */

/** Machine-readable `details.code`s, so this client branches on them rather than on message text. */
const val GOOGLE_OAUTH_NOT_CONFIGURED_CODE = "google_oauth_not_configured"
const val GOOGLE_CALENDAR_NOT_CONNECTED_CODE = "google_calendar_not_connected"
const val GOOGLE_OAUTH_REVOKED_CODE = "google_oauth_revoked"
const val WRITE_CALENDAR_INVALID_CODE = "write_calendar_invalid"

/** The literal Google accepts for "the signed-in account's own calendar". */
const val PRIMARY_CALENDAR_ID = "primary"

/**
 * The two operator-set secrets this feature needs, named in the setup copy the
 * card shows before either is configured. Matches `googleOAuth.ts`'s
 * `GOOGLE_OAUTH_SECRETS` and `CALLABLE_CONTRACT.md`'s setup steps exactly; the
 * VALUES are never named anywhere, only these two names.
 */
val GOOGLE_OAUTH_SECRET_NAMES = listOf("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET")

/**
 * The deployed callback URL the operator registers on the OAuth client in
 * Google Cloud Console. A default only: `startGoogleCalendarConnect` and
 * `getGoogleCalendarConnection` both echo the server's own value, which is
 * preferred wherever it is available so this constant cannot drift silently
 * out of sync with `googleOAuth.ts`.
 */
const val GOOGLE_OAUTH_REDIRECT_URI = "https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback"

/** Same address shape as the free/busy id: a local part, an `@`, and a dotted domain. */
private val CALENDAR_ID_PATTERN = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

/**
 * What `primary` actually points at, so two spellings of one calendar cannot be
 * mistaken for two calendars. An operator can share their OWN calendar with the
 * free/busy service account and then pick `primary` here as the write target;
 * the raw strings differ, the calendar does not, and the echo loop would be
 * live. Comparing resolved ids is what catches that.
 *
 * Case-folded because Google treats calendar ids (they are addresses)
 * case-insensitively, while string equality does not.
 */
fun resolveCalendarId(rawId: String, connectedAccountEmail: String): String {
    val value = rawId.trim().lowercase()
    if (value == PRIMARY_CALENDAR_ID) return connectedAccountEmail.trim().lowercase()
    return value
}

/**
 * The operator-facing reason [writeCalendarId] cannot be the calendar visits
 * are pushed to, or null when it can be.
 *
 * [freeBusyCalendarId] is `business_settings.calendarSyncId` (empty when the
 * free/busy sync is not set up, in which case there is nothing to collide
 * with). [connectedAccountEmail] is the Google account the OAuth connection
 * belongs to, used only to resolve `primary`; pass `""` before a connection
 * exists, in which case `primary` simply cannot be compared against the
 * free/busy calendar, which is why this is also enforced server-side at save
 * and push time.
 */
fun writeCalendarProblem(
    writeCalendarId: String,
    freeBusyCalendarId: String,
    connectedAccountEmail: String,
): String? {
    val value = writeCalendarId.trim()
    if (value.isEmpty()) {
        return "Pick the calendar AuntieOS should write visits to."
    }
    if (value.lowercase() != PRIMARY_CALENDAR_ID && !CALENDAR_ID_PATTERN.matches(value)) {
        return "\"$value\" is not a Google Calendar ID. Pick one from the list of calendars on the " +
            "connected account rather than typing it, so the ID matches what Google expects."
    }
    val freeBusy = freeBusyCalendarId.trim().lowercase()
    if (freeBusy.isEmpty()) return null
    if (resolveCalendarId(value, connectedAccountEmail) == freeBusy) {
        return "That is the calendar the free/busy sync already imports from, so every visit written to " +
            "it would come straight back as blocked-out time and the Schedule would show the same hour " +
            "twice. Pick a different calendar for visits, or clear the Calendar ID above first."
    }
    return null
}

// ── The connection projection ────────────────────────────────────────────────

/**
 * Mirrors `PublicGoogleCalendarConnection` field for field. Built by naming
 * each field rather than by trusting a raw map shape at every call site, so a
 * server field this client does not yet read still has one place to add it.
 * NEVER carries a refresh token: the server projection this is built from does
 * not have one either, under any key.
 */
data class GoogleCalendarConnection(
    val connected: Boolean = false,
    val googleAccountEmail: String = "",
    val connectedAt: String = "",
    val scopes: List<String> = emptyList(),
    val writeCalendarId: String = "",
    val enabledCalendarIds: List<String> = emptyList(),
    val disconnectedAt: String = "",
    val disconnectedError: String = "",
    val connectLastAttemptAt: String = "",
    val connectLastStatus: String = "",
    val connectLastError: String = "",
    val calendarPushLastRunAt: String = "",
    val calendarPushLastStatus: String = "",
    val calendarPushLastPushed: Int = 0,
    val calendarPushLastError: String = "",
)

// ── The last-push receipt ────────────────────────────────────────────────────

private val PUSH_STAMP_FORMAT = DateTimeFormatter.ofPattern("MM-dd HH:mm")

private fun formatPushStamp(iso: String): String = try {
    PUSH_STAMP_FORMAT.format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
} catch (_: Exception) {
    // A hand-edited or legacy stamp must not delete the fact that a push happened.
    "at an unreadable time"
}

/**
 * ONE line describing what the last push to Google Calendar did, in the style
 * of `calendarSyncRunLabel` (7.1's receipt line). Null when
 * [GoogleCalendarConnection.calendarPushLastRunAt] is blank, meaning nothing has
 * ever been pushed; the card renders that in its own words rather than as a
 * silent absence, because "never pushed" and "pushed zero visits" are different
 * facts and conflating them is how a broken push looks like a working one that
 * just has nothing to do.
 *
 * A push of zero is reported as "nothing needed pushing", never folded into the
 * failure branch and never worded like a success that moved data: it is a
 * true, clean run that happened to find no visit in the window.
 */
fun googleCalendarPushLabel(connection: GoogleCalendarConnection): String? {
    val stamp = connection.calendarPushLastRunAt.trim()
    if (stamp.isEmpty()) return null
    val atStamp = formatPushStamp(stamp)
    if (connection.calendarPushLastStatus != "ok") {
        return "Last push $atStamp, and it failed."
    }
    val pushed = connection.calendarPushLastPushed
    if (pushed <= 0) {
        return "Last push $atStamp. Nothing needed pushing."
    }
    val visits = if (pushed == 1) "1 visit" else "$pushed visits"
    return "Last push $atStamp. Pushed $visits."
}
