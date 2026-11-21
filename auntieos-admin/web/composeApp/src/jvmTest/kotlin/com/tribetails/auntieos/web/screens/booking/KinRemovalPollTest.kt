package com.tribetails.auntieos.web.screens.booking

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2121 review: the Kin removal queue is read again on a timer, a failed read
 * comes back sooner, a Retry restarts the timer rather than adding a second
 * one, and nothing is read once the screen has gone.
 */
@OptIn(ExperimentalTestApi::class)
class KinRemovalPollTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun reads() = JvmFirestoreFixtures.callablePayloads.count { it.first == "listKinRemovalRequests" }

    @Test
    fun theQueueIsReadOnTheFloorStopsWhenTheScreenGoesAndRetryNeverStacks() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf("listKinRemovalRequests" to """{"requests":[]}""")
        mainClock.autoAdvance = false
        var shown by mutableStateOf(true)
        var state: KinRemovalQueueState? = null
        setContent { if (shown) state = rememberKinRemovalQueue(enabled = true) }
        mainClock.advanceTimeBy(16L)
        assertEquals(1, reads(), "read once on arrival")

        mainClock.advanceTimeBy(KIN_REMOVAL_REFRESH_MS - 1_000L)
        assertEquals(1, reads(), "not again before the floor")
        mainClock.advanceTimeBy(2_000L)
        assertEquals(2, reads(), "again at the floor")

        // Retry twice: the timer restarts once, it does not run twice over.
        state!!.retry()
        state!!.retry()
        mainClock.advanceTimeBy(16L)
        val afterRetry = reads()
        mainClock.advanceTimeBy(KIN_REMOVAL_REFRESH_MS + 1_000L)
        assertEquals(afterRetry + 1, reads(), "one timer after Retry, not two")

        shown = false
        mainClock.advanceTimeBy(16L)
        val gone = reads()
        mainClock.advanceTimeBy(KIN_REMOVAL_REFRESH_MS * 3)
        assertEquals(gone, reads(), "nothing is read once the screen has gone")
    }

    @Test
    fun aFailedReadTriesAgainInTenSeconds() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf("listKinRemovalRequests" to "The read did not land.")
        mainClock.autoAdvance = false
        setContent { rememberKinRemovalQueue(enabled = true) }
        mainClock.advanceTimeBy(16L)
        assertEquals(1, reads())
        mainClock.advanceTimeBy(KIN_REMOVAL_RETRY_MS + 1_000L)
        assertEquals(2, reads(), "a failed read comes back after the short wait, not the floor")
    }
}
