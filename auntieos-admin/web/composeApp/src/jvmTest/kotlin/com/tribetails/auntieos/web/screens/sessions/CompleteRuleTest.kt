package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1608: the console's copy of the server's COMPLETE gate. Cases and sentence
 * are the server's own (`mytribe/functions/src/lib/arrivalVerification.ts`).
 */
class CompleteRuleTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private fun session(arrivedAt: String = "", departedAt: String = "") =
        KinCareSession(_id = "s1", status = "ARRIVED", arrivedAt = arrivedAt, departedAt = departedAt)

    @Test
    fun unstampedVisitIsMissingBothStepsArrivalFirst() {
        assertEquals(listOf("arrival", "departure"), missingVisitSteps("", ""))
        assertEquals(listOf("arrival"), missingVisitSteps("  ", "2026-11-05T20:30:00Z"))
        assertEquals(listOf("departure"), missingVisitSteps("2026-11-05T20:00:00Z", ""))
    }

    @Test
    fun refusalIsTheServerSentence() {
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
    fun stampedVisitOrRuleOffOrUnknownIsNotRefused() {
        assertNull(completeRefusal(true, session("2026-11-05T20:00:00Z", "2026-11-05T20:30:00Z")))
        assertNull(completeRefusal(false, session()))
        assertNull(completeRefusal(null, session()))
    }

    @Test
    fun ruleIsReadRawAndAbsentReadsAsOff() = runBlocking {
        JvmFirestoreFixtures.arrivalRuleRaw = true
        assertEquals(WriteResult.Ok(true), FirestoreClient().arrivalRuleRequired())
        JvmFirestoreFixtures.arrivalRuleRaw = false
        assertEquals(WriteResult.Ok(false), FirestoreClient().arrivalRuleRequired())
        // A fixture set with no switch on the document: the key is absent, so off,
        // even though the decoded BusinessSettings model would default it to true.
        JvmFirestoreFixtures.arrivalRuleRaw = null
        JvmFirestoreFixtures.businessSettings = com.tribetails.auntieos.web.data.BusinessSettings()
        assertEquals(WriteResult.Ok(false), FirestoreClient().arrivalRuleRequired())
    }
}
