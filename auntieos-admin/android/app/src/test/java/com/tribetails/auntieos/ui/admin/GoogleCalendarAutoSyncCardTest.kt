package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarAutoSyncCard
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarUiState
import com.tribetails.auntieos.ui.admin.scheduling.autoSyncIsArmed
import com.tribetails.auntieos.ui.admin.scheduling.googleCalendarAutoSyncLabel
import com.tribetails.auntieos.ui.admin.scheduling.retryableAutoSyncSessionId
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Issue #397: the automatic per-visit calendar sync's receipt and its retry.
 *
 * A DIFFERENT card from GoogleCalendarConnectCardTest (which covers connect,
 * calendar selection and the bulk push) and from GoogleCalendarSyncCardTest
 * (Task 7.1's free/busy read).
 *
 *  - no calendar chosen -> explains what WILL happen, offers no retry
 *  - a calendar chosen  -> says automatic sync is live, with no on/off switch
 *  - a failed run       -> renders as failed with the server's own words, and
 *                          offers a retry aimed at the named visit
 *  - a failure naming no visit -> no retry, because it was about the connection
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GoogleCalendarAutoSyncCardTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun connection(
        connected: Boolean = true,
        writeCalendarId: String = "work@group.calendar.google.com",
        autoRunAt: String = "",
        autoStatus: String = "",
        autoAction: String = "",
        autoSessionId: String = "",
        autoError: String = "",
    ) = GoogleCalendarConnection(
        connected = connected,
        googleAccountEmail = "auntie@tribetails.com",
        connectedAt = "2026-07-01T00:00:00.000Z",
        scopes = emptyList(),
        writeCalendarId = writeCalendarId,
        enabledCalendarIds = listOf(writeCalendarId),
        disconnectedAt = "",
        disconnectedError = "",
        connectLastAttemptAt = "",
        connectLastStatus = "",
        connectLastError = "",
        calendarPushLastRunAt = "",
        calendarPushLastStatus = "",
        calendarPushLastPushed = 0,
        calendarPushLastError = "",
        calendarAutoSyncLastRunAt = autoRunAt,
        calendarAutoSyncLastStatus = autoStatus,
        calendarAutoSyncLastAction = autoAction,
        calendarAutoSyncLastSessionId = autoSessionId,
        calendarAutoSyncLastError = autoError,
    )

    private fun setCard(
        state: GoogleCalendarUiState,
        onRetryVisit: (String) -> Unit = {},
        onDismissNote: () -> Unit = {},
    ) {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.LIGHT) {
                GoogleCalendarAutoSyncCard(
                    state = state,
                    onRetryVisit = onRetryVisit,
                    onDismissNote = onDismissNote,
                )
            }
        }
    }

    @Test
    fun noCalendarChosen_explainsWhatWillHappen_andOffersNoRetry() {
        setCard(GoogleCalendarUiState(connection = connection(writeCalendarId = "")))

        rule.onNodeWithText("Once a calendar is chosen", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Retry that visit").assertDoesNotExist()
    }

    @Test
    fun calendarChosen_saysAutomaticSyncIsLive_andHasNotRunYet() {
        setCard(GoogleCalendarUiState(connection = connection()))

        rule.onNodeWithText("Confirming a visit puts it on this calendar", substring = true)
            .assertIsDisplayed()
        rule.onNodeWithText("has not needed to run yet", substring = true).assertIsDisplayed()
    }

    @Test
    fun successfulRun_saysWhatItActuallyDid() {
        setCard(
            GoogleCalendarUiState(
                connection = connection(
                    autoRunAt = "2026-08-23T09:00:00.000Z",
                    autoStatus = "ok",
                    autoAction = "created",
                    autoSessionId = "sess-1",
                ),
            ),
        )

        rule.onNodeWithText("put a visit on the calendar", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Retry that visit").assertDoesNotExist()
    }

    @Test
    fun failedRun_surfacesTheServersOwnWords_andOffersARetryForThatVisit() {
        var retried: String? = null
        setCard(
            GoogleCalendarUiState(
                connection = connection(
                    autoRunAt = "2026-08-23T09:00:00.000Z",
                    autoStatus = "error",
                    autoSessionId = "sess-42",
                    autoError = "Google has rejected the saved connection.",
                ),
            ),
            onRetryVisit = { retried = it },
        )

        rule.onNodeWithText("and it failed", substring = true).assertIsDisplayed()
        // The server's message names the actual remedy; a friendly "couldn't
        // sync" here would delete the only text saying what to do next.
        rule.onNodeWithText("Google has rejected the saved connection.", substring = true)
            .assertIsDisplayed()

        rule.onNodeWithText("Retry that visit").performClick()
        assertEquals("sess-42", retried)
    }

    @Test
    fun failureAboutTheConnection_offersNoRetry_becauseThereIsNoOneVisitToRetry() {
        setCard(
            GoogleCalendarUiState(
                connection = connection(
                    autoRunAt = "2026-08-23T09:00:00.000Z",
                    autoStatus = "error",
                    autoSessionId = "",
                    autoError = "That is the calendar the free/busy sync already imports from.",
                ),
            ),
        )

        rule.onNodeWithText("Retry that visit").assertDoesNotExist()
        rule.onNodeWithText("nothing to retry on its own", substring = true).assertIsDisplayed()
    }

    @Test
    fun retryInFlight_disablesTheButtonAndSaysSo() {
        setCard(
            GoogleCalendarUiState(
                connection = connection(
                    autoRunAt = "2026-08-23T09:00:00.000Z",
                    autoStatus = "error",
                    autoSessionId = "sess-42",
                ),
                retryingVisitSync = true,
            ),
        )

        rule.onNodeWithText("Retrying...").assertIsDisplayed()
    }

    @Test
    fun aSkippedRetryIsReportedAsASkip_neverAsASuccess() {
        setCard(
            GoogleCalendarUiState(
                connection = connection(
                    autoRunAt = "2026-08-23T09:00:00.000Z",
                    autoStatus = "error",
                    autoSessionId = "sess-42",
                ),
                visitSyncNote = "Nothing was written for that visit. It has no end time.",
            ),
        )

        rule.onNodeWithText("Nothing was written for that visit", substring = true)
            .assertIsDisplayed()
    }
}

/**
 * The pure helpers, asserted without a Compose tree. These carry the wording
 * and the retry decision, which are the parts worth pinning; a test that has to
 * lay out a card to check a sentence is testing the layout.
 */
class GoogleCalendarAutoSyncLabelTest {

    private fun conn(
        connected: Boolean = true,
        writeCalendarId: String = "work@group.calendar.google.com",
        runAt: String = "2026-08-23T09:00:00.000Z",
        status: String = "ok",
        action: String = "created",
        sessionId: String = "sess-1",
        error: String = "",
    ) = GoogleCalendarConnection(
        connected = connected,
        writeCalendarId = writeCalendarId,
        calendarAutoSyncLastRunAt = runAt,
        calendarAutoSyncLastStatus = status,
        calendarAutoSyncLastAction = action,
        calendarAutoSyncLastSessionId = sessionId,
        calendarAutoSyncLastError = error,
    )

    @Test
    fun neverRun_isNull_soTheCardCanSaySoInItsOwnWords() {
        assertNull(googleCalendarAutoSyncLabel(conn(runAt = "")))
    }

    @Test
    fun eachActionGetsItsOwnSentence() {
        assertTrue(googleCalendarAutoSyncLabel(conn(action = "created"))!!.contains("put a visit on the calendar"))
        assertTrue(googleCalendarAutoSyncLabel(conn(action = "updated"))!!.contains("moved a visit already on the calendar"))
        assertTrue(googleCalendarAutoSyncLabel(conn(action = "deleted"))!!.contains("took a cancelled visit off the calendar"))
        assertTrue(googleCalendarAutoSyncLabel(conn(action = "skipped"))!!.contains("found nothing to change"))
    }

    @Test
    fun anUnrecognisedActionIsReported_notGuessedAt() {
        // Rendering an unknown action as "nothing to change" would be inventing
        // reassurance about a state nobody has seen.
        assertTrue(googleCalendarAutoSyncLabel(conn(action = "teleported"))!!.contains("unrecognised result (teleported)"))
        assertTrue(googleCalendarAutoSyncLabel(conn(action = ""))!!.contains("unrecognised result (blank)"))
    }

    @Test
    fun anUnreadableStatusReadsAsAFailure_neverAsASuccess() {
        // A receipt we cannot parse is not evidence anything worked.
        assertTrue(googleCalendarAutoSyncLabel(conn(status = "weird"))!!.contains("it failed"))
    }

    @Test
    fun anUnreadableTimestampStillReportsThatItRan() {
        assertTrue(googleCalendarAutoSyncLabel(conn(runAt = "not-a-date"))!!.contains("at an unreadable time"))
    }

    @Test
    fun retryIsOfferedOnlyForAFailureThatNamesAVisit() {
        assertEquals("sess-1", retryableAutoSyncSessionId(conn(status = "error")))
        assertNull(retryableAutoSyncSessionId(conn(status = "ok")))
        assertNull(retryableAutoSyncSessionId(conn(status = "error", sessionId = "  ")))
        assertNull(retryableAutoSyncSessionId(conn(runAt = "")))
    }

    @Test
    fun autoSyncIsArmedExactlyWhenACalendarIsChosen() {
        // Choosing the calendar IS the switch. There is no state where one is
        // selected and visits silently never reach it.
        assertTrue(autoSyncIsArmed(conn()))
        assertFalse(autoSyncIsArmed(conn(writeCalendarId = "")))
        assertFalse(autoSyncIsArmed(conn(connected = false)))
    }
}
