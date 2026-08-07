@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
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

class BookingDetailsScreenTest {

    private val tenHoursMs = 10L * 60L * 60L * 1000L
    private val oneHourMs = 1L * 60L * 60L * 1000L
    private val fixedNow = 1_700_000_000_000L

    private fun stubBooking(
        fake: FakeFunctionsClient,
        bookingId: String,
        startMs: Long,
        notes: String? = null,
        status: String = "confirmed",
        cancelRequested: Boolean = false,
    ) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", bookingId)
                    put("kinfolkId", "3")
                    put("status", status)
                    put("title", "Park Adventure")
                    put("serviceType", "Drop-in Visit")
                    put("startTimeMs", startMs)
                    put("auntieDisplayName", "Auntie Avery")
                    put("kinNames", buildJsonArray { add("Buddy") })
                    put("cancelRequested", cancelRequested)
                    notes?.let { put("notes", it) }
                })
            })
            put("recent", buildJsonArray {})
        })
    }

    @Test
    fun rendersBookingMetadata_serviceAuntieKin() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Park Adventure").assertIsDisplayed()
        onNodeWithText("Auntie Avery").assertIsDisplayed()
        onNodeWithText("Buddy").assertIsDisplayed()
        onNodeWithText("Additional Information").assertIsDisplayed()
    }

    @Test
    fun beforeCutoff_saveButtonDisabledWhenNoteBlank_enabledWhenTyped() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        // Blank -> disabled
        onNodeWithText("Save Note").assertIsNotEnabled()
    }

    @Test
    fun withinCutoff_showsLockedBannerAndDisablesSave() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        // start is only 1hr away, within the 3hr cutoff
        stubBooking(fake, "b1", fixedNow + oneHourMs)

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Notes locked (visit starts in under 3hr).").assertIsDisplayed()
        onNodeWithText("Save Note").assertIsNotEnabled()
    }

    @Test
    fun rendersExistingNote_whenBookingCarriesNotesField() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs, notes = "Use side gate; Buddy hates the front bell.")

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("On File").assertIsDisplayed()
        onNodeWithText("Use side gate; Buddy hates the front bell.").assertIsDisplayed()
    }

    @Test
    fun enRouteBooking_showsAuntieEnRouteDistinctFromInProgress() = runComposeUiTest {
        // Pins BookingStatus.EnRoute to its own label ("Auntie en route") so a
        // future edit can't quietly collapse it back onto Active's "In
        // progress" the way the web timeline once did (PR22).
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs, status = "enRoute")

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Auntie en route").assertIsDisplayed()
    }

    @Test
    fun bookingNotFound_rendersError() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "missing",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Booking not found.").assertIsDisplayed()
    }

    @Test
    fun loadError_rendersErrorBanner() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyBookings", IllegalStateException("schedule down"))

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("schedule down").assertIsDisplayed()
    }

    // -- Cancellation ask --

    @Test
    fun upcomingVisit_offersRequestCancellation() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Need to cancel?").assertIsDisplayed()
        onNodeWithText("Request cancellation").assertIsDisplayed()
    }

    @Test
    fun completedVisit_hidesCancellationSection() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow - tenHoursMs, status = "completed")

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Need to cancel?").assertDoesNotExist()
        onNodeWithText("Request cancellation").assertDoesNotExist()
    }

    @Test
    fun cancelAlreadyRequested_showsPendingCaptionInsteadOfAction() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs, cancelRequested = true)

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Cancellation requested. We'll confirm soon.").assertIsDisplayed()
        onNodeWithText("Request cancellation").assertDoesNotExist()
    }

    @Test
    fun cancelFlow_confirmThenSend_rendersPendingState() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true)
            put("visitId", "b1")
            put("alreadyPending", false)
        })

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Request cancellation").performClick()
        waitForIdle()
        onNodeWithText("Send request").assertIsDisplayed()
        onNodeWithText("Keep visit").assertIsDisplayed()

        onNodeWithText("Send request").performClick()
        waitForIdle()

        onNodeWithText("Cancellation requested. We'll confirm soon.").assertIsDisplayed()
        onNodeWithText("Request cancellation").assertDoesNotExist()
    }

    @Test
    fun cancelFlow_serverError_showsMessageAndKeepsAction() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)
        fake.stubError("requestBookingCancellation", IllegalStateException("office is offline"))

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
            )
        }
        waitForIdle()

        onNodeWithText("Request cancellation").performClick()
        waitForIdle()
        onNodeWithText("Send request").performClick()
        waitForIdle()

        onNodeWithText("office is offline").assertIsDisplayed()
        onNodeWithText("Send request").assertIsDisplayed()
    }
}
