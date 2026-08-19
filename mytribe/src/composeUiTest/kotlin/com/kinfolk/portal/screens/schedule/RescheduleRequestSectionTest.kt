@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The reschedule ask on the visit detail screen (#469), state for state
 * against what the web BookingDetail renders.
 *
 * A household PROPOSES here. Nothing in these tests should ever show the visit
 * moving, only the ask being made and answered.
 */
class RescheduleRequestSectionTest {

    /** 2026-08-17T15:30:00Z, a Monday. */
    private val fixedNow = 1_786_980_600_000L
    private val tenHoursMs = 10L * 60L * 60L * 1000L

    private fun stubVisit(
        fake: FakeFunctionsClient,
        status: String = "confirmed",
        batchId: String? = "batch-1",
        rescheduleStatus: String? = null,
        proposedStartMs: Long? = null,
        responseNote: String? = null,
    ) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v1")
                    put("kinfolkId", "fam-1")
                    put("status", status)
                    put("title", "Park Adventure")
                    put("serviceType", "Drop-in Visit")
                    put("startTimeMs", fixedNow + tenHoursMs)
                    batchId?.let { put("batchId", it) }
                    rescheduleStatus?.let { put("rescheduleRequestStatus", it) }
                    proposedStartMs?.let { put("rescheduleRequestedStartTimeMs", it) }
                    responseNote?.let { put("rescheduleResponseNote", it) }
                })
            })
            put("recent", buildJsonArray {})
        })
    }

    @Composable
    private fun Screen(fake: FakeFunctionsClient) {
        KinCareDetailScreen(
            kinCareId = "v1",
            kinfolkId = "fam-1",
            portalApi = PortalApi(fake),
            onBack = {},
            nowMs = { fixedNow },
        )
    }

    @Test
    fun upcomingVisit_offersTheAskWithoutMovingAnything() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Need a different time?").assertExists()
        onNodeWithText("Reschedule visit").assertExists()
    }

    @Test
    fun visitWithNoBookingEnvelope_hidesTheAskRatherThanFailingOnTap() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake, batchId = null)

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Need a different time?").assertDoesNotExist()
        onNodeWithText("Reschedule visit").assertDoesNotExist()
    }

    @Test
    fun completedVisit_isPastAsking() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake, status = "completed")

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Reschedule visit").assertDoesNotExist()
    }

    @Test
    fun pendingAsk_showsTheProposedTimeAndNoSecondAsk() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        // 2026-08-18T13:00:00Z.
        stubVisit(fake, rescheduleStatus = "pending", proposedStartMs = 1_787_058_000_000L)

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("New time requested for", substring = true).assertExists()
        onNodeWithText("Reschedule visit").assertDoesNotExist()
    }

    @Test
    fun acceptedAsk_saysSoAndCarriesTheOfficesNote() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(
            fake,
            rescheduleStatus = "accepted",
            proposedStartMs = 1_787_058_000_000L,
            responseNote = "Auntie Avery has you down for the new slot.",
        )

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText(
            "Your new time was accepted. This visit now shows the time you asked for. " +
                "Auntie Avery has you down for the new slot.",
        ).assertExists()
    }

    @Test
    fun declinedAsk_namesTheTimeItCouldNotTakeAndWhy() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(
            fake,
            rescheduleStatus = "declined",
            proposedStartMs = 1_787_058_000_000L,
            responseNote = "She is booked solid that afternoon.",
        )

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("could not take", substring = true).assertExists()
        onNodeWithText("She is booked solid that afternoon.", substring = true).assertExists()
        // A declined ask is answered, so another one is allowed.
        onNodeWithText("Reschedule visit").assertExists()
    }

    @Test
    fun declinedAskWithNoRecordedTime_stillReadsAsASentence() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake, rescheduleStatus = "declined")

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Tribe Tails could not take that time.", substring = true).assertExists()
    }

    @Test
    fun form_refusesAnEmptyProposalBeforeItReachesTheServer() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("Pick a date and time first.").assertExists()
        // Nothing was sent: the only call is the screen's own load.
        assertEquals(listOf("getMyBookings"), fake.calls.map { it.first })
    }

    @Test
    fun form_sendsTheProposalAndThenReadsAsPending() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", 1_787_058_000_000L)
            put("proposedEndTimeMs", JsonNull)
        })

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        // Day 20 of the four weeks on offer, all of which are ahead of today.
        onNodeWithText("20").performScrollTo().performClick()
        onNodeWithTag("rescheduleTime").performTextInput("13:00")
        onNodeWithTag("rescheduleReason").performTextInput("School run moved")
        waitForIdle()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()

        val sent = fake.calls.first { it.first == "requestBookingReschedule" }.second
        assertEquals("batch-1", sent?.get("batchId")?.toString()?.trim('"'))
        assertEquals("v1", sent?.get("visitId")?.toString()?.trim('"'))
        assertEquals("School run moved", sent?.get("reason")?.toString()?.trim('"'))
        val proposed = sent?.get("proposedStartTimeMs")?.toString()?.toLong()
        assertTrue(proposed != null && proposed > fixedNow, "proposed time should be ahead of now, was $proposed")

        onNodeWithText("New time requested", substring = true).assertExists()
        onNodeWithText("Send this time to Tribe Tails").assertDoesNotExist()
    }

    @Test
    fun form_showsTheServersRefusalWordForWordAndKeepsTheForm() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        fake.stubError(
            "requestBookingReschedule",
            IllegalStateException("A new time is already waiting on Tribe Tails for this visit."),
        )

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("20").performScrollTo().performClick()
        onNodeWithTag("rescheduleTime").performTextInput("13:00")
        waitForIdle()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("A new time is already waiting on Tribe Tails for this visit.").assertExists()
        onNodeWithText("Send this time to Tribe Tails").assertExists()
    }

    @Test
    fun form_foldsAwayAgainOnNeverMind() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Never mind").performScrollTo().performClick()
        waitForIdle()

        onNodeWithText("Send this time to Tribe Tails").assertDoesNotExist()
        onNodeWithText("Reschedule visit").assertExists()
    }
}
