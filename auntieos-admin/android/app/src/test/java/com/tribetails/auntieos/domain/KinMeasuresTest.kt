package com.tribetails.auntieos.domain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
/** #1583: the same cases as web `lib/kinMeasures.test.ts`, so the clients cannot drift. */
class KinMeasuresTest {
    @Test
    fun `accepts good ages`() {
        for (v in listOf("", "  ", "5", "0.5", "12", "1.25", "100")) assertNull(v, validateKinAge(v))
    }

    @Test
    fun `refuses bad ages`() {
        for (v in listOf("abc-5", "5 yrs", "-1", "1,5", ".5", "5.", "101", "1e3", "5-6", "ten")) {
            assertEquals(v, KIN_AGE_MESSAGE, validateKinAge(v))
        }
    }

    @Test
    fun `a legacy age stands until edited, and can be corrected`() {
        assertNull(validateKinAge("abc-5", "abc-5"))
        assertNull(validateKinAge("abc-5 ", " abc-5"))
        assertEquals(KIN_AGE_MESSAGE, validateKinAge("abc-6", "abc-5"))
        assertNull(validateKinAge("5", "abc-5"))
        assertNull(validateKinAge("", "abc-5"))
    }

    @Test
    fun `accepts good weights`() {
        for (v in listOf("", "45", "45 lb", "45lbs", "12.5 kg", "8 OZ", "300g", "0.5 kg")) assertNull(v, validateKinWeight(v))
    }

    @Test
    fun `refuses bad weights`() {
        for (v in listOf("heavy-ish", "abc", "45 stone", "-3", "0", "0 lb", "10000", "lb", "4 5", "1.234 kg")) {
            assertEquals(v, KIN_WEIGHT_MESSAGE, validateKinWeight(v))
        }
    }

    @Test
    fun `a legacy weight stands until edited`() {
        assertNull(validateKinWeight("heavy-ish", "heavy-ish"))
        assertEquals(KIN_WEIGHT_MESSAGE, validateKinWeight("heavy", "heavy-ish"))
        assertNull(validateKinWeight("40 lb", "heavy-ish"))
    }
}
