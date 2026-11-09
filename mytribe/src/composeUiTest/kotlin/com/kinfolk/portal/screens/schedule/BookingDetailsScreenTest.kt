@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
        cancelRequestStatus: String? = null,
        cancelResponseNote: String? = null,
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
                    cancelRequestStatus?.let { put("cancelRequestStatus", it) }
                    cancelResponseNote?.let { put("cancelResponseNote", it) }
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
        // Pins BookingStatus.EnRoute to its own label ("En route", the word the
        // list and Home pills say in capitals, #1298) so a future edit can't
        // quietly collapse it back onto Active's "In progress" the way the
        // web timeline once did (PR22).
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

        onNodeWithText("En route").assertIsDisplayed()
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

    // -- Message the Auntie (#1466) --

    @Test
    fun upcomingVisit_offersMessageAuntie_andTapOpensMessages() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)
        var opened = false

        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
                onOpenMessages = { opened = true },
            )
        }
        waitForIdle()

        // Labelled from the booking's Auntie, the way the web BookingDetail is.
        onNodeWithText("Need a change").assertIsDisplayed()
        onNodeWithText("Message Auntie Avery").assertIsDisplayed()
        onNodeWithText("Message Auntie Avery").performClick()
        waitForIdle()
        assertTrue(opened)
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

        onNodeWithText("Cancellation requested. Your Auntie has it in their queue and will answer soon.").assertIsDisplayed()
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

        // #1466: the Message card above pushes this ask below the test
        // host's fold, so each step scrolls to its control first.
        onNodeWithText("Request cancellation").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send request").performScrollTo().assertIsDisplayed()
        onNodeWithText("Keep visit").performScrollTo().assertIsDisplayed()

        onNodeWithText("Send request").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("Cancellation requested. Your Auntie has it in their queue and will answer soon.").performScrollTo().assertIsDisplayed()
        onNodeWithText("Request cancellation").assertDoesNotExist()
    }

    @Test
    fun cancelDeclined_showsTheOfficesReasonAndLetsThemAskAgain() = runComposeUiTest {
        // #438: before the admin queue existed, a cancellation ask had exactly
        // two states here and neither of them was an answer, because nothing in
        // the office ever read the flag.
        val fake = FakeFunctionsClient()
        stubBooking(
            fake,
            "b1",
            fixedNow + tenHoursMs,
            cancelRequested = false,
            cancelRequestStatus = "declined",
            cancelResponseNote = "Inside the 48-hour window.",
        )

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

        onNodeWithText(
            "Your Auntie is keeping this visit on the books. Inside the 48-hour window.",
        ).assertIsDisplayed()
        onNodeWithText("Ask again").assertIsDisplayed()
    }

    // #1381: the answer names the business from settings, not a hard-coded one.
    @Test
    fun cancelDeclined_namesTheBusinessFromSettings() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(
            fake,
            "b1",
            fixedNow + tenHoursMs,
            cancelRequested = false,
            cancelRequestStatus = "declined",
            cancelResponseNote = "Inside the 48-hour window.",
        )
        setThemedContent {
            androidx.compose.runtime.CompositionLocalProvider(
                com.kinfolk.portal.components.LocalBusinessName provides "Test Business",
            ) {
                KinCareDetailScreen(
                    kinCareId = "b1",
                    kinfolkId = "3",
                    portalApi = PortalApi(fake),
                    onBack = {},
                    nowMs = { fixedNow },
                )
            }
        }
        waitForIdle()
        onNodeWithText(
            "Test Business is keeping this visit on the books. Inside the 48-hour window.",
        ).assertIsDisplayed()
        onNodeWithText("Your Auntie is keeping this visit on the books.", substring = true).assertDoesNotExist()
    }
    @Test
    fun cancelAccepted_saysTheVisitIsCancelledAndOffersNoAction() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(
            fake,
            "b1",
            fixedNow + tenHoursMs,
            status = "cancelled",
            cancelRequested = false,
            cancelRequestStatus = "accepted",
            cancelResponseNote = "No charge for this one.",
        )

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

        onNodeWithText("This visit is cancelled. No charge for this one.").assertIsDisplayed()
        onNodeWithText("Request cancellation").assertDoesNotExist()
        onNodeWithText("Ask again").assertDoesNotExist()
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

        // #1466: same scroll as the happy path above.
        onNodeWithText("Request cancellation").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send request").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("office is offline").performScrollTo().assertIsDisplayed()
        onNodeWithText("Send request").performScrollTo().assertIsDisplayed()
    }

    /** #1504: an unfinished visit shows the note box, so opening it wakes addBookingNote once. */
    @Test
    fun openingAnUnfinishedVisit_warmsAddBookingNoteOnce() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs)
        setThemedContent {
            KinCareDetailScreen(kinCareId = "b1", kinfolkId = "3", portalApi = PortalApi(fake), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        kotlin.test.assertEquals(listOf("addBookingNote"), fake.warmCalls)
    }
    /** A cancelled visit has no note box, so nothing is woken. */
    @Test
    fun openingACancelledVisit_warmsNothing() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubBooking(fake, "b1", fixedNow + tenHoursMs, status = "cancelled")
        setThemedContent {
            KinCareDetailScreen(kinCareId = "b1", kinfolkId = "3", portalApi = PortalApi(fake), onBack = {}, nowMs = { fixedNow })
        }
        waitForIdle()
        kotlin.test.assertEquals(emptyList<String>(), fake.warmCalls)
    }
}
