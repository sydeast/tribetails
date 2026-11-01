@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
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
        /** #1098: a night waiting on the Auntie's start time, with no startTimeMs at all. */
        requestedNight: String? = null,
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
                    if (requestedNight != null) {
                        put("startTimePending", true)
                        put("requestedDate", requestedNight)
                    } else {
                        put("startTimeMs", fixedNow + tenHoursMs)
                    }
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

    /**
     * #1098: the Auntie sets an overnight's start time, and the server refuses
     * to reschedule a night that has none yet. So the ask is held back with the
     * reason, the night shows instead of a time, and cancelling stays open.
     */
    @Test
    fun nightAwaitingItsStartTime_saysWhyAndKeepsCancel() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        // 2026-08-21 is a Friday.
        stubVisit(fake, status = "requested", requestedNight = "2026-08-21")
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("Fri night · Start time set by your Auntie").assertExists()
        // The time line used to read "TBD" for a visit with no start. (The Kin
        // row still says "TBD" here only because this stub names no kin.)
        onAllNodesWithText("TBD").assertCountEquals(1)
        onNodeWithText("Your Auntie has not set the start time yet.").assertExists()
        onNodeWithText("Reschedule visit").assertDoesNotExist()
        onNodeWithText("Request cancellation", substring = true).performScrollTo().assertExists()
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
        // Nothing was sent: the only calls are the screen's own reads.
        assertTrue(fake.calls.none { it.first == "requestBookingReschedule" })
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

    // -- #1284: the booking wizard's day grid, blocks and hours --
    private fun stubCalendar(fake: FakeFunctionsClient, closedDate: String? = null, hours: Boolean = false) {
        fake.stub("getBusinessClosures", buildJsonObject {
            put("closures", buildJsonArray {
                closedDate?.let { add(buildJsonObject { put("date", it); put("name", "Owner away") }) }
            })
            put("weeklyHours", buildJsonArray {
                if (hours) for (d in 0..6) add(buildJsonObject {
                    put("weekday", d)
                    put("open", true)
                    put("startTime", "09:00")
                    put("endTime", "17:00")
                })
            })
            put("timeZone", "America/Chicago")
        })
    }
    private fun stubBlockOnlyPolicy(fake: FakeFunctionsClient) {
        fake.stub("getBookingPolicy", buildJsonObject {
            put("allowTimeBlockBooking", true)
            put("allowSpecificTimeBooking", false)
            put("defaultBookingMode", "TIME_BLOCK")
            put("timeBlocks", buildJsonArray {
                add(buildJsonObject {
                    put("id", "morning"); put("label", "Morning")
                    put("startTime", "08:00"); put("endTime", "12:00"); put("durationMinutes", 240)
                })
                add(buildJsonObject {
                    put("id", "afternoon"); put("label", "Afternoon")
                    put("startTime", "12:00"); put("endTime", "17:00"); put("durationMinutes", 300)
                })
            })
        })
    }
    @Test
    fun form_refusesTwoAMOutsideThatDaysHoursAndSendsNothing() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        stubCalendar(fake, hours = true)
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("20").performScrollTo().performClick()
        onNodeWithTag("rescheduleTime").performTextInput("02:00")
        waitForIdle()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("We are open 09:00 to 17:00", substring = true).assertExists()
        assertTrue(fake.calls.none { it.first == "requestBookingReschedule" })
    }
    @Test
    fun form_leavesAClosedCompanyDayInertSoNothingIsPickedFromIt() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        // 2026-08-20 is the day the other tests tap.
        stubCalendar(fake, closedDate = "2026-08-20")
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("Reschedule visit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("20").performScrollTo().performClick()
        waitForIdle()
        // The closed day did not select, so there is still no time to type.
        onNodeWithTag("rescheduleTime").assertDoesNotExist()
        onNodeWithText("Pick a day to see the times.").assertExists()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Pick a date and time first.").assertExists()
        assertTrue(fake.calls.none { it.first == "requestBookingReschedule" })
    }
    @Test
    fun form_offersTimeBlocksWhenTheBusinessBooksByBlockAndSendsTheBlockId() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        stubCalendar(fake)
        stubBlockOnlyPolicy(fake)
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
        // No clock field in block-only mode.
        onNodeWithTag("rescheduleTime").assertDoesNotExist()
        onNodeWithText("20").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Afternoon (12 PM to 5 PM)").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send this time to Tribe Tails").performScrollTo().performClick()
        waitForIdle()
        val sent = fake.calls.first { it.first == "requestBookingReschedule" }.second
        assertEquals("afternoon", sent?.get("timeBlockId")?.toString()?.trim('"'))
        // 12:00 Chicago on Aug 20 (CDT, UTC-5) is 17:00Z.
        assertEquals(1_787_245_200_000L, sent?.get("proposedStartTimeMs")?.toString()?.toLong())
    }
    // -- #1283: the notes the household wrote, read back --
    @Test
    fun notes_showTheBookingNoteAndEachSavedNoteWithWhenItWasWritten() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        fake.stub("getBookingNotes", buildJsonObject {
            put("bookingNote", "QA walk test booking - please cancel.")
            put("notes", buildJsonArray {
                add(buildJsonObject {
                    put("id", "n1"); put("body", "Back door is easier.")
                    put("createdAtMs", 1_786_980_600_000L)
                })
            })
        })
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("QA walk test booking - please cancel.").performScrollTo().assertExists()
        onNodeWithText("Back door is easier.").performScrollTo().assertExists()
        onNodeWithText("When you booked").assertExists()
        val call = fake.calls.first { it.first == "getBookingNotes" }.second
        assertEquals("batch-1", call?.get("batchId")?.toString()?.trim('"'))
        assertEquals("v1", call?.get("visitId")?.toString()?.trim('"'))
    }
    @Test
    fun notes_sayNothingYetWhenThereAreNone() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        fake.stub("getBookingNotes", buildJsonObject {
            put("bookingNote", JsonNull)
            put("notes", buildJsonArray {})
        })
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("Nothing yet.").performScrollTo().assertExists()
    }
    @Test
    fun notes_saySoWhenTheyCouldNotBeLoadedAndKeepTheNoteBox() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake)
        fake.stubError("getBookingNotes", RuntimeException("offline"))
        setThemedContent { Screen(fake) }
        waitForIdle()
        onNodeWithText("We couldn't load your notes.").performScrollTo().assertExists()
        onNodeWithText("Save Note").performScrollTo().assertExists()
    }
    @Test
    fun notes_areNotAskedForOnAVisitWithNoBookingEnvelope() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubVisit(fake, batchId = null)
        setThemedContent { Screen(fake) }
        waitForIdle()
        assertTrue(fake.calls.none { it.first == "getBookingNotes" })
        onNodeWithText("Your notes").assertDoesNotExist()
    }
}
