package com.kinfolk.portal

import com.kinfolk.portal.firebase.RestEndpoints
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #889 review round 3, item 5: windowTitle was inline in main() with no
 * test. Extracted so it can take an injected RestEndpoints, not read
 * FirebaseRestConfig (and therefore process env) directly.
 */
class MainTest {

    private fun endpoints(env: Map<String, String>) = RestEndpoints(env = { env[it] })

    @Test
    fun plainTitleWhenNothingIsConfigured() {
        assertEquals("MyTribe", windowTitle(endpoints(emptyMap())))
    }

    @Test
    fun emulatorSuffixWhenAnySwitchIsActive() {
        assertEquals(
            "MyTribe [EMULATOR]",
            windowTitle(endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099"))),
        )
        assertEquals(
            "MyTribe [EMULATOR]",
            windowTitle(endpoints(mapOf("FIRESTORE_EMULATOR_HOST" to "127.0.0.1:8080"))),
        )
    }

    /** #889 review round 3, item 7: a rejected switch is visible here too, not only on stderr. */
    @Test
    fun ignoredSuffixWhenASwitchWasSetButRejected() {
        assertEquals(
            "MyTribe [Emulator setting ignored]",
            windowTitle(endpoints(mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "8.8.8.8:9099"))),
        )
    }

    @Test
    fun activeWinsOverRejectedWhenBothAreTrue() {
        assertEquals(
            "MyTribe [EMULATOR]",
            windowTitle(
                endpoints(
                    mapOf(
                        "FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099",
                        "FUNCTIONS_EMULATOR_HOST" to "8.8.8.8:5001",
                    ),
                ),
            ),
        )
    }
}
