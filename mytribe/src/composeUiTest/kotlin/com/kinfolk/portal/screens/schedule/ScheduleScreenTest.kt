@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class ScheduleScreenTest {

    @Test
    fun empty_showsRequestBookingButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("No upcoming bookings").assertIsDisplayed()
        onNodeWithText("Request a Booking").assertIsDisplayed()
    }

    @Test
    fun requestBookingButton_firesOnOpenWizard() = runComposeUiTest {
        // The wizard is now a nav destination, so the list screen only emits the
        // open-wizard callback. (Wizard step-1 render is covered in
        // BookingWizardTest.) Assert the click invokes the callback.
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        var opened = false
        setThemedContent {
            ScheduleScreen(
                "The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient(),
                onOpenWizard = { opened = true },
            )
        }
        waitForIdle()
        onNodeWithText("Request a Booking").performClick()
        waitForIdle()
        kotlin.test.assertTrue(opened, "tapping Request a Booking should fire onOpenWizard")
    }

    @Test
    fun bookingCardClick_firesOnOpenKinCare() = runComposeUiTest {
        // Tapping an upcoming visit now emits onOpenKinCare(visitId, batchId)
        // instead of owning a selected-id; the host routes to KinCareDetailRoute.
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("status", "confirmed")
                    put("title", "Park Adventure")
                })
            })
            put("recent", buildJsonArray {})
        })
        var openedVisit: String? = null
        setThemedContent {
            ScheduleScreen(
                "The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient(),
                onOpenKinCare = { visitId, _ -> openedVisit = visitId },
            )
        }
        waitForIdle()
        onNodeWithText("Park Adventure").performClick()
        waitForIdle()
        kotlin.test.assertEquals("b1", openedVisit)
    }

    /**
     * #1098: an overnight waiting on the Auntie's start time has no startTimeMs.
     * The row shows its requested night, on the calendar tile and in words,
     * and never a blank, a midnight or "Invalid Date". The web mirror is
     * "Schedule, a visit whose start time the Auntie sets (#1098)".
     */
    @Test
    fun nightAwaitingItsStartTime_showsItsNightAndWhoSetsTheStart() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("status", "requested")
                    put("serviceType", "Overnight")
                    put("startTimeMs", JsonNull)
                    put("startTimePending", true)
                    put("requestedDate", "2026-10-09")
                })
            })
            put("recent", buildJsonArray {})
        })
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("Fri night · Start time set by your Auntie").assertIsDisplayed()
        onNodeWithText("OCT").assertIsDisplayed()
        onNodeWithText("09").assertIsDisplayed()
        onNodeWithText("12:00 AM", substring = true).assertDoesNotExist()
    }
    @Test
    fun requestedVisit_saysREQUESTED_andNamesTheChangeWaitingOnTheOffice() = runComposeUiTest {
        // #1298 / #1299: one word for the status, and the open ask under it.
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("status", "requested")
                    put("title", "Park Adventure")
                    put("rescheduleRequestStatus", "pending")
                })
            })
            put("recent", buildJsonArray {})
        })
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("REQUESTED").assertIsDisplayed()
        onNodeWithText("New time requested").assertIsDisplayed()
    }
    @Test
    fun bookings_renderAuntieAndKinNames() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("status", "confirmed")
                    put("title", "Park Adventure")
                    put("auntieDisplayName", "Auntie Avery")
                    put("kinNames", buildJsonArray { add("Buddy"); add("Willow") })
                })
            })
            put("recent", buildJsonArray {})
        })
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("Park Adventure").assertIsDisplayed()
        onNodeWithText("Auntie Avery • Buddy, Willow").assertIsDisplayed()
    }

    @Test
    fun goodToKnowShortcuts_alwaysShown() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient())
        }
        waitForIdle()
        // The "Good to know" aside with its recurring-visit shortcut is always present.
        onNodeWithText("Good to know").assertIsDisplayed()
        onNodeWithText("Set up a recurring visit").assertIsDisplayed()
    }

    @Test
    fun schedule_hasNoMessageAuntieControl() = runComposeUiTest {
        // #1464: Messages is a bar tab and each booking keeps its own message
        // link, so the Schedule aside no longer offers a "Message Auntie" button.
        // Schedule does not wire the ScreenHeader chip either, so no Messages
        // control of any kind should render on this screen.
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("status", "confirmed")
                    put("title", "Park Adventure")
                })
            })
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient())
        }
        waitForIdle()
        onNodeWithText("Good to know").assertIsDisplayed()
        onNodeWithText("Set up a recurring visit").assertIsDisplayed()
        onNodeWithText("Message Auntie", substring = true, ignoreCase = true).assertDoesNotExist()
        onNodeWithText("Message your Auntie", substring = true, ignoreCase = true).assertDoesNotExist()
    }

    @Test
    fun upcomingBatch_groupsIntoEnvelopeCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        // Two upcoming KinCares sharing one batchId collapse into a single envelope
        // card labelled "2 visits" (envelope grouping is always on).
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "kc1")
                    put("status", "confirmed")
                    put("serviceType", "Drop-in Visit")
                    put("title", "Park Adventure")
                    put("batchId", "batch-1")
                })
                add(buildJsonObject {
                    put("id", "kc2")
                    put("status", "requested")
                    put("serviceType", "Drop-in Visit")
                    put("title", "Park Adventure")
                    put("batchId", "batch-1")
                })
            })
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient())
        }
        waitForIdle()
        onNodeWithText("2 visits").assertIsDisplayed()
    }

    @Test
    fun error_rendersFailureCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyBookings", IllegalStateException("schedule down"))
        setThemedContent { ScheduleScreen("The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient()) }
        waitForIdle()
        onNodeWithText("Couldn't load schedule").assertIsDisplayed()
    }
}
