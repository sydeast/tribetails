package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The write-target rule and the last-push receipt, the two halves of
 * GoogleCalendarTargets.kt (Task 7.2, the OAuth calendar).
 *
 * The `writeCalendarProblem` cases here are the SAME six the enforcing copy
 * (`mytribe/functions/src/lib/googleCalendarTargets.ts`, asserted in
 * `mytribe/functions/test/callableContract.test.ts`) and the React mirror
 * (`auntieos-admin/src/lib/googleCalendarTargets.test.ts`) assert. If one
 * moves, all three move in the same change. See CALLABLE_CONTRACT.md.
 */
class GoogleCalendarTargetsTest {

    private val account = "auntie@tribetails.com"

    @Test
    fun `primary is allowed with no free-busy calendar configured`() {
        assertNull(writeCalendarProblem(PRIMARY_CALENDAR_ID, "", account))
    }

    @Test
    fun `a real group calendar id is allowed`() {
        assertNull(writeCalendarProblem("work@group.calendar.google.com", "", account))
    }

    @Test
    fun `empty is refused as nothing picked yet`() {
        assertNotNull(writeCalendarProblem("", "", account))
    }

    @Test
    fun `a bare word is refused as not calendar-id shaped`() {
        assertNotNull(writeCalendarProblem("team-cal", "", account))
    }

    @Test
    fun `the free-busy calendar itself is refused, the echo loop`() {
        val problem = writeCalendarProblem(
            "shared@g.calendar.google.com",
            "shared@g.calendar.google.com",
            account,
        )
        assertNotNull(problem)
        assertTrue(problem!!.contains("blocked-out time"))
    }

    @Test
    fun `primary is refused when the connected account IS the free-busy calendar`() {
        // Two spellings of the same calendar: resolving primary against the
        // connected account and comparing to the free/busy id is what catches it.
        assertNotNull(writeCalendarProblem(PRIMARY_CALENDAR_ID, account, account))
    }

    // ── resolveCalendarId ────────────────────────────────────────────────────

    @Test
    fun `resolveCalendarId maps primary onto the connected account, case-folded`() {
        assertEquals("auntie@tribetails.com", resolveCalendarId("PRIMARY", "Auntie@TribeTails.com"))
    }

    @Test
    fun `resolveCalendarId leaves a real id alone, only case-folded and trimmed`() {
        assertEquals("work@group.calendar.google.com", resolveCalendarId("  Work@Group.Calendar.Google.com  ", account))
    }

    // ── the last-push receipt ────────────────────────────────────────────────

    private fun connection(
        calendarPushLastRunAt: String = "",
        calendarPushLastStatus: String = "",
        calendarPushLastPushed: Int = 0,
        calendarPushLastError: String = "",
    ) = GoogleCalendarConnection(
        connected = true,
        googleAccountEmail = account,
        connectedAt = "2026-07-01T00:00:00.000Z",
        scopes = emptyList(),
        writeCalendarId = "primary",
        enabledCalendarIds = listOf("primary"),
        disconnectedAt = "",
        disconnectedError = "",
        connectLastAttemptAt = "",
        connectLastStatus = "",
        connectLastError = "",
        calendarPushLastRunAt = calendarPushLastRunAt,
        calendarPushLastStatus = calendarPushLastStatus,
        calendarPushLastPushed = calendarPushLastPushed,
        calendarPushLastError = calendarPushLastError,
    )

    @Test
    fun `never pushed renders as null, not a zero-push success`() {
        assertNull(googleCalendarPushLabel(connection()))
    }

    @Test
    fun `a failed push reads as failed`() {
        val label = googleCalendarPushLabel(
            connection(
                calendarPushLastRunAt = "2026-07-25T14:30:00.000Z",
                calendarPushLastStatus = "error",
                calendarPushLastError = "google_oauth_revoked",
            ),
        )
        assertTrue(label!!.contains("it failed"))
    }

    @Test
    fun `a push of zero says nothing needed pushing, a different fact from never having pushed`() {
        val label = googleCalendarPushLabel(
            connection(
                calendarPushLastRunAt = "2026-07-25T14:30:00.000Z",
                calendarPushLastStatus = "ok",
                calendarPushLastPushed = 0,
            ),
        )
        assertTrue(label!!.contains("Nothing needed pushing"))
    }

    @Test
    fun `a successful push names the count, singularized at one`() {
        val many = googleCalendarPushLabel(
            connection(
                calendarPushLastRunAt = "2026-07-25T14:30:00.000Z",
                calendarPushLastStatus = "ok",
                calendarPushLastPushed = 3,
            ),
        )
        assertTrue(many!!.contains("Pushed 3 visits."))

        val one = googleCalendarPushLabel(
            connection(
                calendarPushLastRunAt = "2026-07-25T14:30:00.000Z",
                calendarPushLastStatus = "ok",
                calendarPushLastPushed = 1,
            ),
        )
        assertTrue(one!!.contains("Pushed 1 visit."))
    }

    @Test
    fun `an unreadable stamp still reports the outcome`() {
        val label = googleCalendarPushLabel(
            connection(
                calendarPushLastRunAt = "not-a-date",
                calendarPushLastStatus = "ok",
                calendarPushLastPushed = 2,
            ),
        )
        assertTrue(label!!.contains("unreadable time"))
    }

    @Test
    fun `the four detail codes match the server`() {
        assertEquals("google_oauth_not_configured", GOOGLE_OAUTH_NOT_CONFIGURED_CODE)
        assertEquals("google_calendar_not_connected", GOOGLE_CALENDAR_NOT_CONNECTED_CODE)
        assertEquals("google_oauth_revoked", GOOGLE_OAUTH_REVOKED_CODE)
        assertEquals("write_calendar_invalid", WRITE_CALENDAR_INVALID_CODE)
    }
}
