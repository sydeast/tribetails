package com.kinfolk.portal.screens.kin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** #1583: the same weight cases as the other clients, plus the portal's whole-year age box. */
class KinMeasuresTest {
    @Test
    fun goodWeightsPass() {
        for (v in listOf("", "45", "45 lb", "45lbs", "12.5 kg", "8 OZ", "300g", "0.5 kg")) assertNull(validateKinWeight(v), v)
    }

    @Test
    fun badWeightsAreRefused() {
        for (v in listOf("heavy-ish", "abc", "45 stone", "-3", "0", "0 lb", "10000", "lb", "4 5", "1.234 kg")) {
            assertEquals(KIN_WEIGHT_MESSAGE, validateKinWeight(v), v)
        }
    }

    @Test
    fun aLegacyWeightStandsUntilEdited() {
        assertNull(validateKinWeight("heavy-ish", "heavy-ish"))
        assertEquals(KIN_WEIGHT_MESSAGE, validateKinWeight("heavy", "heavy-ish"))
        assertNull(validateKinWeight("40 lb", "heavy-ish"))
    }

    @Test
    fun ageStopsAtOneHundred() {
        for (v in listOf("", "0", "5", "100")) assertNull(validateKinAgeText(v), v)
        for (v in listOf("101", "999", "abc", "-1")) assertEquals(KIN_AGE_MESSAGE, validateKinAgeText(v), v)
        assertNull(validateKinAgeText("150", "150"))
    }
}
