package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.admin.scheduling.CalendarSyncRun
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
 *
 * Added 2026-07-25 (Task 7.1, parity with the React admin's CalendarSyncSection):
 *  - no saved id, or a saved id that cannot work -> no Run Sync button, and the
 *    card says which it is. The callable reads the SAVED value, so a button that
 *    ran on an unsaved or unusable id would import nothing and report success.
 *  - the last-run receipt, including a FAILED run, read back from the server's
 *    own stamp so it outlives this screen.
 *  - a mistyped id never reaches the doc.
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
                    lastRun = null,
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
                    // A SAVED, usable id: Run Sync acts on the saved value, so it
                    // is deliberately absent until there is one worth running.
                    calendarSyncId = "team@group.calendar.google.com",
                    calendarSyncIdSaved = false,
                    lastRun = null,
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
    fun noCalendarIdSaved_offersNoRunSync_andSaysWhy() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "",
                    calendarSyncIdSaved = false,
                    lastRun = null,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Run Sync").assertDoesNotExist()
        rule.onNodeWithText("Nothing to sync yet.", substring = true).assertIsDisplayed()
    }

    @Test
    fun neverSynced_saysSo_ratherThanImplyingACleanRun() {
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "team@group.calendar.google.com",
                    calendarSyncIdSaved = false,
                    lastRun = null,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("This calendar has never been synced.").assertIsDisplayed()
    }

    @Test
    fun storedReceipt_survivesTheScreen_includingAFailedRun() {
        // The point of stamping failures server-side: a sync that broke and a
        // sync that never ran look identical otherwise, and the operator finds
        // out by pressing the button again.
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "team@group.calendar.google.com",
                    calendarSyncIdSaved = false,
                    lastRun = CalendarSyncRun("2026-07-25T14:30:00.000Z", false, 0, "calendar_not_shared"),
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("and it failed.", substring = true).assertIsDisplayed()
    }

    @Test
    fun mistypedId_blocksSave_andSaysItWouldLookLikeAnEmptyCalendar() {
        var saved: String? = null
        rule.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                GoogleCalendarSyncCard(
                    syncEnabled = true,
                    isSyncing = false,
                    errorMessage = null,
                    successMessage = null,
                    calendarSyncId = "team-cal",
                    calendarSyncIdSaved = false,
                    lastRun = null,
                    onSaveCalendarSyncId = { saved = it },
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        // assertExists, not assertIsDisplayed: the explanation is three lines
        // long and this composable is rendered outside a scroll container here,
        // so the node is present but can sit below the test viewport.
        rule.onNodeWithText("import nothing", substring = true).assertExists()
        rule.onNodeWithText("Save Calendar ID").performClick()
        assertTrue("a refused id must never reach the doc, got $saved", saved == null)
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
                    lastRun = null,
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
                    lastRun = null,
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
                    lastRun = null,
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
                    lastRun = null,
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
                    lastRun = null,
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
                    lastRun = null,
                    onSaveCalendarSyncId = {},
                    onRunSync = {},
                    onDismissError = {},
                )
            }
        }
        rule.onNodeWithText("Calendar ID saved.").assertIsDisplayed()
    }
}
