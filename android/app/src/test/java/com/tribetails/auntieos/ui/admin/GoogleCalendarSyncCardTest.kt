package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Slice 8 UI: GoogleCalendarSyncCard states.
 *  - flag OFF  -> dark "not enabled" banner, no Run Sync button
 *  - flag ON   -> Run Sync button; click invokes onRunSync
 *  - syncing   -> spinner label, no button
 *  - error     -> server message text rendered verbatim (SA name surfaces)
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GoogleCalendarSyncCardTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun flagOff_showsDarkBanner_noRunSyncButton() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = false,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Calendar sync not enabled yet").assertIsDisplayed()
        rule.onNodeWithText("Run Sync").assertDoesNotExist()
    }

    @Test
    fun flagOn_showsRunSync_andClickInvokesCallback() {
        var clicked = false
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = { clicked = true },
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Run Sync").assertIsDisplayed()
        rule.onNodeWithText("Run Sync").performClick()
        assertTrue("onRunSync must fire on click", clicked)
    }

    @Test
    fun syncing_showsSpinnerLabel_noButton() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = true,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Syncing...").assertIsDisplayed()
        rule.onNodeWithText("Run Sync").assertDoesNotExist()
    }

    @Test
    fun error_rendersServerMessageNamingTheServiceAccount() {
        val serverMsg =
            "calendar_not_shared: share calendar team-cal with " +
                "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at \"See only free/busy (hide details)\" so the sync service account can read availability."
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = serverMsg,
                    successMessage = null,
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText(serverMsg).assertIsDisplayed()
    }

    @Test
    fun success_rendersImportedCountLine() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = "Imported 2 busy blocks.",
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Imported 2 busy blocks.").assertIsDisplayed()
    }

    @Test
    fun calendarIdField_seedsPersistedValue_andSurfacesServiceAccountHint() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = false,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "team@group.calendar.google.com",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        // Field is present even when sync is not enabled (admin must configure first).
        rule.onNodeWithText("team@group.calendar.google.com").assertIsDisplayed()
        // Hint must name the exact service account the admin shares the calendar with.
        rule.onNodeWithText(
            "Share this calendar with " +
                "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com" +
                " at See only free/busy (hide details), then save the calendar id here."
        ).assertIsDisplayed()
        rule.onNodeWithText("Save Calendar ID").assertIsDisplayed()
    }

    @Test
    fun calendarIdField_saveButton_emitsCurrentValue() {
        var saved: String? = null
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "cal-1@group.calendar.google.com",
                    calendarSyncIdSaved = false,
                    onSaveCalendarSyncId = { saved = it },
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Save Calendar ID").performClick()
        assertTrue(
            "onSaveCalendarSyncId must fire with the seeded value, got $saved",
            saved == "cal-1@group.calendar.google.com"
        )
    }

    @Test
    fun calendarIdField_savedConfirmation_rendersWhenFlagSet() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "cal-1@group.calendar.google.com",
                    calendarSyncIdSaved = true,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Calendar ID saved.").assertIsDisplayed()
    }
}
