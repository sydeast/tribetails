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
import kotlin.test.assertTrue

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
        // The "Good to know" aside with both shortcuts is always present.
        onNodeWithText("Good to know").assertIsDisplayed()
        onNodeWithText("Set up a recurring visit").assertIsDisplayed()
    }

    @Test
    fun messageAuntieCta_navigates() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        var opened = false
        // Schedule does not wire the ScreenHeader chip (it's opt-in + hidden there),
        // so "Message Auntie" is the aside KinGhostButton. Click it and assert
        // the navigation callback fired (no more "Coming soon" stub).
        setThemedContent {
            ScheduleScreen(
                "The Foster", "3", PortalApi(fake), com.kinfolk.portal.firebase.FakeFirestoreClient(),
                onOpenMessageAuntie = { opened = true },
            )
        }
        waitForIdle()
        onNodeWithText("Good to know").assertIsDisplayed()
        onNodeWithText("Message Auntie").performClick()
        waitForIdle()
        assertTrue(opened, "Message Auntie CTA should fire onOpenMessageAuntie")
        onNodeWithText("Coming soon.").assertDoesNotExist()
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
