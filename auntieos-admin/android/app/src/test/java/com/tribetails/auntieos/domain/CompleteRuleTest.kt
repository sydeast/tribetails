package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1608: the phone's copy of the server's COMPLETE gate. The cases are the
 * server's own (`mytribe/functions/test/arrivalVerification.test.ts`) and the
 * refusal sentence is the server's, word for word.
 */
class CompleteRuleTest {

    private fun session(arrivedAt: String? = "", departedAt: String? = "") =
        KinCareSession(id = "s1", status = "ARRIVED", arrivedAt = arrivedAt, departedAt = departedAt)

    @Test
    fun `only an explicit true turns the rule on`() {
        assertTrue(arrivalRuleRequired(true))
        assertFalse(arrivalRuleRequired(null))
        assertFalse(arrivalRuleRequired(false))
        assertFalse(arrivalRuleRequired("true"))
    }

    @Test
    fun `an unstamped visit is missing both steps, arrival first`() {
        assertEquals(listOf("arrival", "departure"), missingVisitSteps("", ""))
        assertEquals(listOf("arrival", "departure"), missingVisitSteps(null, null))
    }

    @Test
    fun `a blank stamp counts as missing`() {
        assertEquals(listOf("arrival"), missingVisitSteps("   ", "2026-11-05T20:30:00Z"))
    }

    @Test
    fun `an arrived visit is missing only the departure`() {
        assertEquals(listOf("departure"), missingVisitSteps("2026-11-05T20:00:00Z", ""))
    }

    @Test
    fun `the refusal is the server's sentence`() {
        assertEquals(
            "This visit has no arrival and departure recorded, and your settings require both before a " +
                "visit can be marked complete. Mark it on the visit card first, or turn off " +
                "\"Verify arrival and departure\" in Settings.",
            completeRefusal(true, session()),
        )
        assertTrue(
            completeRefusal(true, session(arrivedAt = "2026-11-05T20:00:00Z"))!!
                .startsWith("This visit has no departure recorded, and your settings require it before"),
        )
    }

    @Test
    fun `a fully stamped visit may be completed`() {
        assertNull(completeRefusal(true, session("2026-11-05T20:00:00Z", "2026-11-05T20:30:00Z")))
    }

    @Test
    fun `nothing is refused when the rule is off or unknown`() {
        assertNull(completeRefusal(false, session()))
        assertNull(completeRefusal(null, session()))
    }
}
