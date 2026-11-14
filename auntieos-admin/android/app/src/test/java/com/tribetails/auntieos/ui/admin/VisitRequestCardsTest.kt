package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import com.tribetails.auntieos.data.repository.IncomingKinCare
import com.tribetails.auntieos.ui.admin.scheduling.LocalBusinessZone
import com.tribetails.auntieos.ui.admin.scheduling.VisitRequestRow
import com.tribetails.auntieos.ui.admin.scheduling.groupIncomingBySeries
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1577: the QA walk could not safely answer a request it had not made itself.
 * The cards named the service and never the household, the card body did not
 * open, and Accept fired in one tap without saying who it was for. These mount
 * the two request cards and drive them the way an operator does.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class VisitRequestCardsTest {

    @get:Rule
    val rule = createComposeRule()

    private val zone = ZoneId.of("America/Chicago")

    private val reschedule = VisitRequestRow.Reschedule(
        RescheduleRequestDto(
            kinfolkId = "fam-1",
            batchId = "b1",
            visitId = "v1",
            kinfolkName = "The Wrens",
            title = "Morning drop-in",
            serviceType = "Drop-in Visit",
            kinNames = listOf("Biscuit"),
            status = "confirmed",
            currentStartTimeMs = 1_790_000_000_000L,
            currentEndTimeMs = null,
            proposedStartTimeMs = 1_790_100_000_000L,
            proposedEndTimeMs = null,
            reason = "Flight moved",
            requestedAtMs = 1_789_000_000_000L,
        ),
    )

    private val cancel = VisitRequestRow.Cancel(
        CancelRequestDto(
            kinfolkId = "fam-2",
            batchId = "b2",
            visitId = "v2",
            kinfolkName = "The Devlins",
            title = "Evening sit",
            serviceType = "Pet Sitting",
            kinNames = listOf("Nutmeg"),
            status = "confirmed",
            startTimeMs = 1_790_000_000_000L,
            endTimeMs = null,
            reason = "We are away",
            requestedAtMs = 1_789_000_000_000L,
        ),
    )

    private fun mountRow(row: VisitRequestRow, resolved: MutableList<String>) {
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    VisitRequestRowCard(
                        row = row,
                        inFlight = false,
                        actionsLocked = false,
                        onResolve = { decision, _ -> resolved += decision },
                    )
                }
            }
        }
    }

    @Test
    fun theCardIsTitledWithTheHousehold() {
        mountRow(reschedule, mutableListOf())
        rule.onNodeWithText("The Wrens").assertExists()
        rule.onNodeWithText("Morning drop-in · Biscuit").assertExists()
    }

    @Test
    fun acceptAsksFirstAndTheConfirmNamesTheHousehold() {
        val resolved = mutableListOf<String>()
        mountRow(reschedule, resolved)

        rule.onNodeWithText("Move the visit").performClick()
        rule.onNodeWithText("Move this visit for The Wrens").assertExists()
        // Nothing is sent until the operator confirms.
        assertEquals(emptyList<String>(), resolved)

        rule.onAllNodesWithText("Move the visit")[1].performClick()
        rule.waitForIdle()
        assertEquals(listOf("accept"), resolved)
    }

    @Test
    fun declineIsHeadedWithTheHousehold() {
        mountRow(cancel, mutableListOf())
        rule.onNodeWithText("Decline").performClick()
        rule.onNodeWithText("Keep this visit for The Devlins").assertExists()
    }

    @Test
    fun theCardBodyOpensTheRequest() {
        mountRow(cancel, mutableListOf())
        rule.onNodeWithText("Evening sit · Nutmeg").performClick()
        rule.onNodeWithText("Cancel request from The Devlins").assertExists()
        // The reason shows on the card and again in the opened request.
        rule.onAllNodesWithText("We are away").assertCountEquals(2)
    }

    @Test
    fun anIncomingRequestOpensWithItsNotesAndConfirmsByHousehold() {
        val series = groupIncomingBySeries(
            listOf(
                IncomingKinCare(
                    familyId = "kf1", batchId = "b1", visitId = "v1", kinfolkId = "kf1",
                    kinfolkName = "The Rowans", serviceType = "Dog Walk",
                    startTime = "2026-12-03T15:00:00Z", status = "requested", kinNames = listOf("Rex"),
                ),
            ),
        ).single()
        var approved = 0
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    IncomingSeriesRow(
                        series = series,
                        inFlight = false,
                        actionsLocked = false,
                        startTimes = emptyMap(),
                        onSetStartTime = { _, _ -> },
                        onApprove = { approved += 1 },
                        onCancel = {},
                        loadNotes = { Result.success("Gate code 1234") },
                    )
                }
            }
        }

        rule.onNodeWithText("The Rowans").performClick()
        rule.onNodeWithText("New request from The Rowans").assertExists()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Gate code 1234").fetchSemanticsNodes().isNotEmpty() }

        rule.onNodeWithText("Approve").performClick()
        rule.onNodeWithText("Book this request for The Rowans").assertExists()
        assertEquals(0, approved)
        rule.onNodeWithText("Book it").performClick()
        rule.waitForIdle()
        assertEquals(1, approved)
    }

    // #2030: the confirm step takes a note for the household and hands it over.
    @Test
    fun theConfirmStepCarriesTheNoteForTheHousehold() {
        val series = groupIncomingBySeries(
            listOf(
                IncomingKinCare(
                    familyId = "kf1", batchId = "b1", visitId = "v1", kinfolkId = "kf1",
                    kinfolkName = "The Rowans", serviceType = "Dog Walk",
                    startTime = "2026-12-03T15:00:00Z", status = "requested", kinNames = listOf("Rex"),
                ),
            ),
        ).single()
        val approved = mutableListOf<String>()
        val declined = mutableListOf<String>()
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    IncomingSeriesRow(
                        series = series,
                        inFlight = false,
                        actionsLocked = false,
                        startTimes = emptyMap(),
                        onSetStartTime = { _, _ -> },
                        onApprove = { approved += it },
                        onCancel = { declined += it },
                    )
                }
            }
        }
        rule.onNodeWithText("Approve series").performClick()
        rule.onNodeWithText("NOTE FOR THE HOUSEHOLD (OPTIONAL)").assertExists()
        rule.onNodeWithTag("householdNote").performTextInput("  Booked. Bring the spare key.  ")
        rule.onNodeWithText("Book it").performClick()
        rule.waitForIdle()
        assertEquals(listOf("Booked. Bring the spare key."), approved)
        // A fresh confirm starts blank: the approval's note never rides a decline.
        rule.onNodeWithText("Cancel").performClick()
        rule.onNodeWithText("ANYTHING TO ADD FOR THE HOUSEHOLD (OPTIONAL)").assertExists()
        rule.onNodeWithText("Booked. Bring the spare key.").assertDoesNotExist()
        rule.onNodeWithTag("householdNote").performTextInput("We are full that week.")
        rule.onNodeWithText("Turn it down").performClick()
        rule.waitForIdle()
        assertEquals(listOf("We are full that week."), declined)
    }
    // #2028: a notification's Open lands with this request's sheet already open,
    // and says so once, so coming back later does not open it again.
    @Test
    fun aRequestOpenedFromANotificationArrivesWithItsSheetOpen() {
        val series = groupIncomingBySeries(
            listOf(
                IncomingKinCare(
                    familyId = "kf1", batchId = "b1", visitId = "v1", kinfolkId = "kf1",
                    kinfolkName = "The Rowans", serviceType = "Dog Walk",
                    startTime = "2026-12-03T15:00:00Z", status = "requested", kinNames = listOf("Rex"),
                ),
            ),
        ).single()
        var opened = 0
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    IncomingSeriesRow(
                        series = series,
                        inFlight = false,
                        actionsLocked = false,
                        startTimes = emptyMap(),
                        onSetStartTime = { _, _ -> },
                        onApprove = {},
                        onCancel = {},
                        openDetailOnArrival = true,
                        onDetailOpened = { opened += 1 },
                    )
                }
            }
        }
        rule.onNodeWithText("New request from The Rowans").assertExists()
        rule.waitForIdle()
        assertEquals(1, opened)
    }
    // #1875: the confirm step names the date it answers, not only the household.
    @Test
    fun theConfirmStepNamesTheDates() {
        val series = groupIncomingBySeries(
            listOf(
                IncomingKinCare(
                    familyId = "kf1", batchId = "b1", visitId = "v1", kinfolkId = "kf1",
                    kinfolkName = "The Rowans", serviceType = "Dog Walk",
                    startTime = "2026-12-03T15:00:00Z", status = "requested", kinNames = listOf("Rex"),
                ),
            ),
        ).single()
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides zone) {
                    IncomingSeriesRow(
                        series = series,
                        inFlight = false,
                        actionsLocked = false,
                        startTimes = emptyMap(),
                        onSetStartTime = { _, _ -> },
                        onApprove = {},
                        onCancel = {},
                    )
                }
            }
        }
        rule.onNodeWithText("Cancel").performClick()
        rule.onNodeWithText("Thu, Dec 3 at 9:00 AM").assertExists()
        rule.onNodeWithText("Nothing will be booked. The household will be told.").assertExists()
    }
}
