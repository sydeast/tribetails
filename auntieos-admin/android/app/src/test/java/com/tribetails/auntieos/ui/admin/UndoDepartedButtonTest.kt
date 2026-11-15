package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * #2250: the "Undo departed" block on the Auntie Time card and the Home card.
 * Offered until the moment the server stamped, sent through the server, with a
 * visible wait and the refusal in the server's words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UndoDepartedButtonTest {

    @get:Rule
    val rule = createComposeRule()

    private val until = "2026-11-14T15:35:00.000Z"
    private val untilMs = Instant.parse(until).toEpochMilli()

    private fun visit(status: String = "COMPLETED", stamp: String? = until) =
        KinCareSession(id = "s1", status = status, kinfolkName = "The Rivera Home", undoDepartedUntil = stamp)

    private fun show(
        session: KinCareSession,
        nowMs: () -> Long = { untilMs - 240_000 },
        onUndone: () -> Unit = {},
        undo: suspend (String) -> Result<Unit> = { Result.success(Unit) },
        watch: (String) -> Flow<Pair<String, String?>> = { emptyFlow() },
    ) {
        rule.setContent {
            AuntieOSTheme {
                UndoDepartedButton(
                    session, session.kinfolkName, onUndone = onUndone, nowMs = nowMs, undo = undo, watch = watch,
                )
            }
        }
    }

    /** The real case: the board read the row straight after the tap, before the server stamped it. */
    @Test
    fun aDepartedRowReadBeforeTheStampIsWatchedUntilTheStampArrives() {
        val server = MutableSharedFlow<Pair<String, String?>>(replay = 1)
        val watched = mutableListOf<String>()
        show(visit(status = "DEPARTED", stamp = null), watch = { id -> watched += id; server })
        rule.onNodeWithText("Undo departed").assertDoesNotExist()
        assertEquals(listOf("s1"), watched)

        server.tryEmit("COMPLETED" to until)
        rule.waitForIdle()
        rule.onNodeWithText("Undo departed").assertIsDisplayed()
    }

    @Test
    fun aRowThatAlreadyCarriesTheStampOpensNoListener() {
        val watched = mutableListOf<String>()
        show(visit(), watch = { id -> watched += id; emptyFlow() })
        rule.onNodeWithText("Undo departed").assertIsDisplayed()
        assertEquals(emptyList<String>(), watched)
    }

    @Test
    fun offeredOnAJustCompletedVisit() {
        show(visit())
        rule.onNodeWithText("Undo departed").assertIsDisplayed()
    }

    @Test
    fun offeredOnAVisitStillDeparted() {
        show(visit(status = "DEPARTED"))
        rule.onNodeWithText("Undo departed").assertIsDisplayed()
    }

    @Test
    fun notDrawnAfterTheWindowOrWithoutOneOrBeforeDeparture() {
        var session by mutableStateOf(visit())
        rule.setContent {
            AuntieOSTheme {
                UndoDepartedButton(session, "", onUndone = {}, nowMs = { untilMs + 1 }, watch = { emptyFlow() })
            }
        }
        rule.onNodeWithText("Undo departed").assertDoesNotExist()
        session = visit(stamp = null)
        rule.onNodeWithText("Undo departed").assertDoesNotExist()
        session = visit(status = "ARRIVED")
        rule.onNodeWithText("Undo departed").assertDoesNotExist()
    }

    @Test
    fun goesByItselfWhenTheTimeIsUp() {
        var now = untilMs - 2_000
        rule.mainClock.autoAdvance = false
        show(visit(), nowMs = { now })
        rule.onNodeWithText("Undo departed").assertIsDisplayed()
        now = untilMs + 5
        rule.mainClock.advanceTimeBy(2_100)
        rule.onNodeWithText("Undo departed").assertDoesNotExist()
    }

    @Test
    fun asksFirstThenSendsShowsTheWaitAndTellsTheScreenToReRead() {
        val answer = CompletableDeferred<Result<Unit>>()
        val sent = mutableListOf<String>()
        var undone = 0
        show(visit(), onUndone = { undone++ }, undo = { id -> sent += id; answer.await() })

        rule.onNodeWithText("Undo departed").performClick()
        rule.onNodeWithText(
            "The Rivera Home’s visit will go back to Arrived, with the arrival time it already has. The household is not told.",
        ).assertIsDisplayed()
        assertEquals(emptyList<String>(), sent)

        rule.onNodeWithText("Yes, undo departed").performClick()
        rule.onNodeWithText("Putting the visit back to Arrived…").assertIsDisplayed()
        rule.onNodeWithText("Undo departed").assertIsNotEnabled()
        assertEquals(listOf("s1"), sent)
        assertEquals(0, undone)

        answer.complete(Result.success(Unit))
        rule.waitForIdle()
        assertEquals(1, undone)
        rule.onNodeWithText("Putting the visit back to Arrived…").assertDoesNotExist()
    }

    @Test
    fun aCallWithNoAnswerSaysToCheckTheConnection() {
        show(visit(), undo = { Result.failure(java.io.IOException("UNAVAILABLE")) })
        rule.onNodeWithText("Undo departed").performClick()
        rule.onNodeWithText("Yes, undo departed").performClick()
        rule.onNodeWithText("Couldn’t undo the departure. Check your connection and try again.").assertIsDisplayed()
    }
}
