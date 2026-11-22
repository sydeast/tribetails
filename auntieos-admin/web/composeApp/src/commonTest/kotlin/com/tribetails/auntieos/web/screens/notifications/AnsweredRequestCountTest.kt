package com.tribetails.auntieos.web.screens.notifications

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1877: after Approve the row read BOOKED while "Needs a decision" kept
 * counting the request until the queue was read again.
 */
class AnsweredRequestCountTest {
    @Test
    fun anAnsweredRequestLeavesTheWaitingSet() {
        assertEquals(setOf("kf2/b2"), pendingLessAnswered(setOf("kf1/b1", "kf2/b2"), listOf("kf1/b1")))
    }

    @Test
    fun nothingAnsweredLeavesTheQueueAsRead() {
        val queue = setOf("kf1/b1")
        assertEquals(queue, pendingLessAnswered(queue, emptyList()))
    }

    @Test
    fun anUnknownQueueStaysUnknown() {
        assertNull(pendingLessAnswered(null, listOf("kf1/b1")))
    }
}
