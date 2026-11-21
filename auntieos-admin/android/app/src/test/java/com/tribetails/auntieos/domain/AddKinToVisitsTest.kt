package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #1822: the answer of `addKinToUpcomingVisits` and the card's wording. */
class AddKinToVisitsTest {

    @Test
    fun `decodes a success, whatever number type the callable layer hands back`() {
        assertEquals(
            AddKinToVisitsAnswer("k1", "Pepper", upcoming = 3, added = 2),
            addKinToVisitsAnswerOf(mapOf("ok" to true, "kinId" to "k1", "kinName" to "Pepper", "upcoming" to 3L, "added" to 2.0)),
        )
    }

    @Test
    fun `a nameless Kin is null and a bad count is zero`() {
        assertEquals(
            AddKinToVisitsAnswer("k1", null, upcoming = 0, added = 0),
            addKinToVisitsAnswerOf(mapOf("ok" to true, "kinId" to "k1", "kinName" to " ", "upcoming" to -4, "added" to "x")),
        )
    }

    @Test
    fun `an answer that is not a success is null`() {
        assertNull(addKinToVisitsAnswerOf(null))
        assertNull(addKinToVisitsAnswerOf(mapOf("kinId" to "k1")))
        assertNull(addKinToVisitsAnswerOf(mapOf("ok" to true)))
    }

    @Test
    fun `the wording names the Kin and the count, and reads right for one visit`() {
        assertEquals("Add Pepper to the 3 upcoming visits", addKinToVisitsLabel("Pepper", 3))
        assertEquals("Add Pepper to the upcoming visit", addKinToVisitsLabel("Pepper", 1))
        assertEquals("Pepper is not on 3 upcoming visits.", kinMissingFromVisitsLine("Pepper", 3))
        assertEquals("Pepper is not on 1 upcoming visit.", kinMissingFromVisitsLine("Pepper", 1))
        assertEquals(
            "Pepper will be on the 3 upcoming visits already booked for this household. Visits that have started or are over stay as they are.",
            addKinToVisitsConfirmLine("Pepper", 3),
        )
        assertEquals("Added Pepper to 3 upcoming visits.", addedKinToVisitsLine("Pepper", 3))
        assertEquals("Added Pepper to 1 upcoming visit.", addedKinToVisitsLine("Pepper", 1))
        assertEquals("Pepper is already on every upcoming visit.", addedKinToVisitsLine("Pepper", 0))
    }
}
