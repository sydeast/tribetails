package com.tribetails.auntieos.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1601: Home's "KinTales to review" counts drafts the way the admin web does. */
class DraftReviewTest {
    @Test
    fun `generated, pending and blank are waiting on review`() {
        assertTrue(isDraftAwaitingReview("generated"))
        assertTrue(isDraftAwaitingReview("pending"))
        assertTrue(isDraftAwaitingReview(" Pending "))
        assertTrue(isDraftAwaitingReview(""))
        assertTrue(isDraftAwaitingReview(null))
    }

    @Test
    fun `approved and unknown statuses are not counted`() {
        assertFalse(isDraftAwaitingReview("approved"))
        assertFalse(isDraftAwaitingReview("sent"))
    }
}
