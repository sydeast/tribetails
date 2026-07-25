package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarUiState
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Task 7.2 UI: GoogleCalendarConnectCard states. A DIFFERENT card from
 * GoogleCalendarSyncCardTest (Task 7.1's free/busy read); this one covers the
 * OAuth connect/push flow.
 *
 *  - server not configured -> the server's message, naming the missing secret
 *    and the exact firebase functions:secrets:set command, renders verbatim
 *  - not connected -> Connect button
 *  - connected -> the account address and a Disconnect button
 *  - a failed last push -> renders as failed, not silently absent
 *  - a connection that has never been pushed -> does not read as a zero-push
 *    success, since those are different facts
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GoogleCalendarConnectCardTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun connection(
        connected: Boolean = true,
        googleAccountEmail: String = "auntie@tribetails.com",
        writeCalendarId: String = "primary",
        disconnectedError: String = "",
        calendarPushLastRunAt: String = "",
        calendarPushLastStatus: String = "",
        calendarPushLastPushed: Int = 0,
    ) = GoogleCalendarConnection(
        connected = connected,
        googleAccountEmail = googleAccountEmail,
        connectedAt = "2026-07-01T00:00:00.000Z",
        scopes = emptyList(),
        writeCalendarId = writeCalendarId,
        enabledCalendarIds = listOf(writeCalendarId),
        disconnectedAt = "",
        disconnectedError = disconnectedError,
        connectLastAttemptAt = "",
        connectLastStatus = "",
        connectLastError = "",
        calendarPushLastRunAt = calendarPushLastRunAt,
        calendarPushLastStatus = calendarPushLastStatus,
        calendarPushLastPushed = calendarPushLastPushed,
        calendarPushLastError = "",
    )

    @Test
    fun notConfigured_rendersServerMessageVerbatim_namingTheMissingSecret() {
        val serverMsg =
            "Google Calendar is not set up on the server yet: GOOGLE_OAUTH_CLIENT_ID and " +
                "GOOGLE_OAUTH_CLIENT_SECRET are not set. In Google Cloud Console for project " +
                "auntieos-ttpc, under APIs and Services, Credentials, create an OAuth client ID of type " +
                "Web application with the redirect URI " +
                "https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback, then from " +
                "mytribe/ run firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID --project " +
                "auntieos-ttpc and firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project " +
                "auntieos-ttpc and redeploy the functions."
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(connection = null, error = serverMsg),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText(serverMsg).assertIsDisplayed()
    }

    @Test
    fun notConnected_showsConnectButton() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(connection = connection(connected = false)),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Connect Google Calendar").assertIsDisplayed()
        rule.onNodeWithText("Disconnect").assertDoesNotExist()
    }

    @Test
    fun connected_showsAccountAddress_andDisconnectButton() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(connection = connection(connected = true)),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Connected as auntie@tribetails.com").assertIsDisplayed()
        rule.onNodeWithText("Disconnect").assertIsDisplayed()
        rule.onNodeWithText("Connect Google Calendar").assertDoesNotExist()
    }

    @Test
    fun aFailedLastPush_rendersAsFailed() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(
                        connection = connection(
                            calendarPushLastRunAt = "2026-07-25T14:30:00.000Z",
                            calendarPushLastStatus = "error",
                        ),
                    ),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("and it failed.", substring = true).assertIsDisplayed()
    }

    @Test
    fun neverPushed_doesNotReadAsAZeroPushSuccess() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(connection = connection()),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Visits have never been pushed to this calendar.").assertIsDisplayed()
        rule.onNodeWithText("Nothing needed pushing", substring = true).assertDoesNotExist()
        rule.onNodeWithText("Pushed", substring = true).assertDoesNotExist()
    }

    @Test
    fun aFailedDisconnect_surfacesTheStoredDisconnectError() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarConnectCard(
                    state = GoogleCalendarUiState(
                        connection = connection(
                            disconnectedError = "Google did not confirm the revoke. Remove Tribe Tails " +
                                "at myaccount.google.com/permissions to be sure.",
                        ),
                    ),
                    onConnect = {},
                    onConsumeAuthUrl = {},
                    onRefreshCalendars = {},
                    onSaveTargets = { _, _ -> },
                    onPush = {},
                    onDisconnect = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("myaccount.google.com/permissions", substring = true).assertIsDisplayed()
    }
}
