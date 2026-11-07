package com.tribetails.auntieos.domain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1582: typing a minus sign in Max gap repriced every package with no message. Mirrors the web `parseMaxGapHours` tests. */
class MaxGapParseTest {
    private fun refused(text: String) = parseMaxGapHours(text) as? MaxGapParse.Refused
    @Test
    fun readsWholeAndFractionalHours() {
        assertEquals(MaxGapParse.Ok(6.0), parseMaxGapHours("6"))
        assertEquals(MaxGapParse.Ok(4.5), parseMaxGapHours(" 4.5 "))
        assertEquals(MaxGapParse.Ok(1.0), parseMaxGapHours("1"))
        // No upper bound: a long gap is the operator's call.
        assertEquals(MaxGapParse.Ok(30.0), parseMaxGapHours("30"))
    }
    @Test
    fun refusesAMinusSignABareMinusAndAnythingNotAPlainNumber() {
        for (bad in listOf("-5", "-", "+5", "1e3", "abc", "4.", ".5", "5h", "1,5")) {
            assertTrue("'$bad' should be refused", refused(bad) != null)
        }
        assertTrue(refused("-5")!!.message.contains("minus sign"))
    }
    @Test
    fun refusesBlankZeroAndUnderOneHour() {
        assertTrue(refused("")!!.message.startsWith("Enter the longest gap"))
        for (out in listOf("0", "0.5")) {
            assertEquals("Max gap must be at least 1 hour.", refused(out)!!.message)
        }
    }
}
