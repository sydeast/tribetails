@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Clock

/** Step 1 (all Kin) -> step 2 (add one KinCare) -> step 3. */
private fun ComposeUiTest.goToStep3() {
    waitForIdle()
    onNodeWithText("Next").performClick()
    waitForIdle()
    onNodeWithText("Auntie's In").performClick()
    onNodeWithText("Next").performClick()
    waitForIdle()
}

/**
 * Clicks the wizard's Next/Create button, scrolling to it first.
 *
 * Step 3 grew a mode toggle and a block picker, so on the desktop test window
 * the footer can sit below the fold — and a Compose click on an off-screen node
 * fails. Scrolling first is what the household does with their thumb.
 */
private fun ComposeUiTest.clickFooter(label: String) {
    onNodeWithText(label).performScrollTo().performClick()
    waitForIdle()
}
/** Taps the 10th of next month: always a bookable future date, and clear of the step indicator's 1-5. */
private fun ComposeUiTest.pickTenthOfNextMonth() {
    onNodeWithContentDescription("Next month").performClick()
    waitForIdle()
    onNodeWithText("10").performClick()
    waitForIdle()
}

/**
 * Time-block booking on the portal Android app. Operator requirement
 * 2026-08-24: "kinfolk book within time blocks, not at a specific set time. I
 * need to be able to create these time blocks and those are what the kinfolk
 * should be able to select from when booking."
 *
 * The web mirror is the "BookingWizard: time-block booking" describe block in
 * mytribe/web/src/screens/BookingWizard.test.tsx. Every one of the four switch
 * combinations is pinned on both clients, including the one where a household
 * must never see a free time field at all.
 */
class BookingWizardTimeBlockTest {

    private fun stubKinAndServices(fake: FakeFunctionsClient) {
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject { put("id", "k1"); put("name", "Buddy"); put("status", "active") })
            })
        })
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s1"); put("name", "Auntie's In")
                    put("category", "Held Down at Home"); put("priceCents", 2500L)
                })
                add(buildJsonObject {
                    put("id", "s2"); put("name", "Overnight Stays")
                    put("category", "Held Down at Home"); put("priceCents", 15000L); put("isOvernight", true)
                })
            })
        })
    }

    /** Stubs `getBookingPolicy` with the two windows and the switches under test. */
    private fun stubPolicy(
        fake: FakeFunctionsClient,
        allowBlocks: Boolean,
        allowSpecific: Boolean,
        default: String,
    ) {
        fake.stub("getBookingPolicy", buildJsonObject {
            put("allowTimeBlockBooking", allowBlocks)
            put("allowSpecificTimeBooking", allowSpecific)
            put("defaultBookingMode", default)
            put("timeBlocks", buildJsonArray {
                add(buildJsonObject {
                    put("id", "midday"); put("label", "Midday")
                    put("startTime", "11:00"); put("endTime", "15:00"); put("durationMinutes", 240)
                })
                add(buildJsonObject {
                    put("id", "evening"); put("label", "Evening")
                    put("startTime", "17:00"); put("endTime", "21:00"); put("durationMinutes", 240)
                })
            })
        })
    }

    @Test
    fun blockOnly_offersTheBusinessWindowsAndNoTimeField() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = false, default = "TIME_BLOCK")
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        onNodeWithText("Midday (11:00-15:00)").assertExists()
        onNodeWithText("Evening (17:00-21:00)").assertExists()
        // The free time field is gone, not merely hidden behind a toggle.
        onNodeWithText("1. Auntie's In time (HH:MM)").assertDoesNotExist()
        // And there is no mode toggle: with one mode on offer there is nothing
        // to decide, and a disabled control would be a control that lies.
        onNodeWithText("A Specific Time").assertDoesNotExist()
    }

    @Test
    fun blockOnly_sendsTheChosenBlockAndItsStartTime() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = false, default = "TIME_BLOCK")
        fake.stub("requestBooking", buildJsonObject { put("batchId", "batch-1") })
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()
        pickTenthOfNextMonth()
        onNodeWithText("Evening (17:00-21:00)").performScrollTo().performClick()
        waitForIdle()
        clickFooter("Next")
        clickFooter("Next")
        clickFooter("Create Booking")

        val payload = fake.calls.last { it.first == "requestBooking" }.second!!
        val visits = payload["visits"]!!.jsonArray
        assertEquals(1, visits.size)
        val visit = visits.single().jsonObject
        assertEquals("evening", visit["timeBlockId"]!!.jsonPrimitive.content)
        // The block says WHEN. The KinCare still says what it costs.
        assertEquals("s1", visit["serviceId"]!!.jsonPrimitive.content)
        val nextMonth = shiftMonth(Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date, 1)
        val expected = LocalDateTime(nextMonth.year, nextMonth.month, 10, 17, 0)
            .toInstant(TimeZone.currentSystemDefault()).toEpochMilliseconds()
        assertEquals(expected, visit["startTimeMs"]!!.jsonPrimitive.long)
    }

    @Test
    fun blockOnly_namesTheWindowOnReviewRatherThanAClockTime() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = false, default = "TIME_BLOCK")
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()
        pickTenthOfNextMonth()
        clickFooter("Next")
        clickFooter("Next")

        onNodeWithText("Review & Confirm").assertExists()
        val nextMonth = shiftMonth(Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date, 1)
        val visit = com.kinfolk.portal.portal.BookingVisit(
            startTimeMs = LocalDateTime(nextMonth.year, nextMonth.month, 10, 11, 0)
                .toInstant(TimeZone.currentSystemDefault()).toEpochMilliseconds(),
            endTimeMs = null,
            serviceId = "s1",
            serviceName = "Auntie's In",
            priceCents = 2500L,
            timeBlockId = "midday",
        )
        val blocks = listOf(com.kinfolk.portal.portal.TimeBlock("midday", "Midday", "11:00", "15:00", 240))
        val line = plannedVisitLine(
            renderPlannedVisits(listOf(visit), TimeZone.currentSystemDefault(), blocks).single(),
        )
        onNodeWithText(line).assertExists()
    }

    @Test
    fun blockOnly_refusesTheSameKinCareInTheSameWindowTwice() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = false, default = "TIME_BLOCK")
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        waitForIdle()
        clickFooter("Next")
        // The SAME duration, twice: both default into the first window.
        onNodeWithText("Auntie's In").performClick()
        onNodeWithText("Auntie's In").performClick()
        clickFooter("Next")
        pickTenthOfNextMonth()

        onNodeWithText(
            "Two KinCares are the same duration in the same time block. Remove one, or move it to another block.",
        ).assertExists()
        onNodeWithText("Next").assertIsNotEnabled()

        // Moving the second one to the other window is what unblocks it.
        onAllNodesWithText("Evening (17:00-21:00)")[1].performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun blockOnly_twoDifferentDurationsInOneWindowAreTwoVisits() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = false, default = "TIME_BLOCK")
        fake.stub("requestBooking", buildJsonObject { put("batchId", "batch-1") })
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        waitForIdle()
        clickFooter("Next")
        onNodeWithText("Auntie's In").performClick()
        onNodeWithText("Overnight Stays").performScrollTo().performClick()
        clickFooter("Next")
        pickTenthOfNextMonth()
        onNodeWithText("Next").assertIsEnabled()
        clickFooter("Next")
        clickFooter("Next")
        clickFooter("Create Booking")

        val visits = fake.calls.last { it.first == "requestBooking" }.second!!["visits"]!!.jsonArray
        assertEquals(2, visits.size)
        assertTrue(visits.all { it.jsonObject["timeBlockId"]!!.jsonPrimitive.content == "midday" })
    }

    @Test
    fun bothModes_opensOnTheDefaultAndTheHouseholdCanSwitch() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = true, allowSpecific = true, default = "TIME_BLOCK")
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        // defaultBookingMode is TIME_BLOCK.
        onNodeWithText("Midday (11:00-15:00)").assertExists()
        onNodeWithText("A Specific Time").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("1. Auntie's In time (HH:MM)").assertExists()
        onNodeWithText("Midday (11:00-15:00)").assertDoesNotExist()
        onNodeWithText("Time Blocks").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Midday (11:00-15:00)").assertExists()
    }

    @Test
    fun specificOnly_isTodaysBehaviourWithNoBlockPickerAtAll() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        stubPolicy(fake, allowBlocks = false, allowSpecific = true, default = "SPECIFIC_TIME")
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        onNodeWithText("1. Auntie's In time (HH:MM)").assertExists()
        onNodeWithText("Midday (11:00-15:00)").assertDoesNotExist()
        onNodeWithText("Time Blocks").assertDoesNotExist()
    }

    /**
     * The read is secondary: losing it leaves the wizard on clock times rather
     * than dead, which is both the pre-time-block behaviour and the fallback
     * `getBookingPolicy` itself returns when its own settings read fails.
     */
    @Test
    fun aFailedPolicyReadLeavesTheWizardUsableOnClockTimes() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        fake.stubError("getBookingPolicy", RuntimeException("offline"))
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        onNodeWithText("1. Auntie's In time (HH:MM)").assertExists()
        pickTenthOfNextMonth()
        onNodeWithText("Next").assertIsEnabled()
    }
}
