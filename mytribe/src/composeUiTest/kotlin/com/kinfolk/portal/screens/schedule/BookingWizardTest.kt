@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.time.Clock

/** Month header the picker prints for [d]'s month, e.g. "August 2026". */
private fun monthHeading(d: LocalDate): String {
    val names = listOf(
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )
    return "${names[d.month.ordinal]} ${d.year}"
}

/** Step 1 (all Kin) -> step 2 (pick a duration) -> step 3 (the date picker). */
private fun ComposeUiTest.goToStep3() {
    waitForIdle()
    onNodeWithText("Next").performClick()
    waitForIdle()
    onNodeWithText("Auntie's In").performClick()
    onNodeWithText("Next").performClick()
    waitForIdle()
}

class BookingWizardTest {

    private fun stubKinAndServices(fake: FakeFunctionsClient) {
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1"); put("name", "Buddy"); put("status", "active")
                })
                add(buildJsonObject {
                    put("id", "k2"); put("name", "Willow"); put("status", "active")
                })
            })
        })
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s1"); put("name", "Auntie's In")
                    put("category", "Held Down at Home"); put("priceMinCents", 1500L); put("priceMaxCents", 8000L)
                })
                add(buildJsonObject {
                    put("id", "s2"); put("name", "Overnight Stays")
                    put("category", "Held Down at Home"); put("priceCents", 15000L); put("isOvernight", true)
                })
            })
        })
    }

    @Test
    fun step1_defaultsToAllKinAndAllowsAdvance() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("All Kin in this home").assertIsDisplayed()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step1_chooseSpecificRequiresSelection() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Choose specific Kin").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsNotEnabled()
        onNodeWithText("Buddy").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step2_listsServicesAndAdvances() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        // Step 1 default = all kin → Next enabled immediately.
        onNodeWithText("Next").performClick()
        waitForIdle()
        // #542: "my services are by time not activity" — this business's
        // catalog is priced by length of visit, so the kinfolk-facing word
        // for step 2 is a duration, not an activity.
        onNodeWithText("Choose KinCare Duration").assertIsDisplayed()
        onNodeWithText("Auntie's In").assertIsDisplayed()
        onNodeWithText("Overnight Stays").assertIsDisplayed()
        onNodeWithText("Next").assertIsNotEnabled()
        onNodeWithText("Auntie's In").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step3_dateAndTimeRequiredBeforeNext() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Next").performClick()
        waitForIdle()
        onNodeWithText("Auntie's In").performClick()
        onNodeWithText("Next").performClick()
        waitForIdle()
        onNodeWithText("Schedule Dates").assertIsDisplayed()
        onNodeWithText("Next").assertIsNotEnabled()
    }

    /**
     * #544: "kinfolk are unable to change months preventing book ahead". The
     * picker was frozen on the current month with no control to leave it.
     */
    @Test
    fun step3_pagesForwardAndBackThroughMonths() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        val today = Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date
        onNodeWithText(monthHeading(today)).assertIsDisplayed()

        onNodeWithContentDescription("Next month").performClick()
        waitForIdle()
        onNodeWithText(monthHeading(shiftMonth(today, 1))).assertIsDisplayed()

        onNodeWithContentDescription("Previous month").performClick()
        waitForIdle()
        onNodeWithText(monthHeading(today)).assertIsDisplayed()
    }

    /**
     * #544 + C1: the single closure window the wizard resolves spans the
     * whole horizon, so a company holiday in a month only reachable by
     * paging forward is already marked when that month is shown.
     */
    @Test
    fun step3_marksAClosureInAMonthReachedByPaging() = runComposeUiTest {
        val today = Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date
        val twoMonthsOut = shiftMonth(today, 2)
        val closed = LocalDate(twoMonthsOut.year, twoMonthsOut.month, 10)

        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        fake.stub("getBusinessClosures", buildJsonObject {
            put("closures", buildJsonArray {
                add(buildJsonObject { put("date", bookingDateKey(closed)); put("name", "Staff retreat") })
            })
        })
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        onNodeWithContentDescription("Next month").performClick()
        waitForIdle()
        onNodeWithContentDescription("Next month").performClick()
        waitForIdle()
        onNodeWithText(monthHeading(closed)).assertIsDisplayed()
        // Day numbers 1-5 collide with the step indicator, hence the 10th/11th.
        onNodeWithText("10").assertHasNoClickAction()
        onNodeWithText("11").assertHasClickAction()
    }

    @Test
    fun step3_cannotPageBeforeTheCurrentMonth() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(kinfolkId = "3", portalApi = PortalApi(fake), onClose = {}, onComplete = {})
        }
        goToStep3()

        val today = Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date
        onNodeWithContentDescription("Previous month").assertHasNoClickAction()
        onNodeWithContentDescription("Next month").performClick()
        waitForIdle()
        onNodeWithContentDescription("Previous month").assertHasClickAction()
        onNodeWithText(monthHeading(shiftMonth(today, 1))).assertIsDisplayed()
    }

    @Test
    fun cancel_callsOnClose() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        var closed = false
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = { closed = true },
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Cancel").performClick()
        waitForIdle()
        kotlin.test.assertTrue(closed, "onClose should fire from Cancel button")
    }
}
