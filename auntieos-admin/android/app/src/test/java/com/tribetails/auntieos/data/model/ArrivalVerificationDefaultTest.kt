package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1620: a `business_settings` document with no `requireArrivalDepartureVerification`
 * key is OFF on the server (`=== true` in functions/src/lib/arrivalVerification.ts).
 * The Android model defaulted to true, so Settings showed the switch ON while Complete
 * went through. Firestore's `toObject` fills an absent field from this default.
 */
class ArrivalVerificationDefaultTest {
    @Test
    fun `an absent key reads as off, the server's reading`() {
        assertFalse(BusinessSettings().requireArrivalDepartureVerification)
    }

    @Test
    fun `saving settings that never touched the switch writes nothing for it`() {
        val loaded = BusinessSettings()
        val edited = loaded.copy(venmoHandle = "@tribe")
        assertFalse(businessSettingsFieldChanges(loaded, edited).containsKey("requireArrivalDepartureVerification"))
    }

    @Test
    fun `turning it on is a real write of true`() {
        val loaded = BusinessSettings()
        assertEquals(
            mapOf<String, Any?>("requireArrivalDepartureVerification" to true),
            businessSettingsFieldChanges(loaded, loaded.copy(requireArrivalDepartureVerification = true)),
        )
    }
}
