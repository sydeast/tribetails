package com.tribetails.auntieos.web.screens.schedule
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1154: a reschedule refused over a Google busy block or another visit shows the server's sentence and offers
 * "Move anyway", which resends with the matching override flag. The same override is never offered twice, and a
 * closed day is a sentence only.
 */
class RescheduleOverrideTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()
    private fun lastBody() = Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.last().second).jsonObject
    private fun attempt(override: ScheduleOverride? = null) =
        RescheduleAttempt("s1", "2026-10-05T14:00:00Z", "2026-10-05T15:00:00Z", override)
    private fun refuse(code: String?, message: String = "Refused.") {
        JvmFirestoreFixtures.callableErrors = mapOf("rescheduleBooking" to message)
        JvmFirestoreFixtures.callableErrorCodes = if (code == null) emptyMap() else mapOf("rescheduleBooking" to code)
    }
    @Test
    fun theRescheduleErrKeepsTheServersCode() = runBlocking {
        refuse("booking_busy_conflict", "That time is busy on your calendar.")
        val r = FirestoreClient().rescheduleBooking("s1", "a", "b")
        assertEquals(WriteResult.Err("That time is busy on your calendar.", "booking_busy_conflict"), r)
    }
    @Test
    fun aFirstRescheduleSendsNoOverrideFlag() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("rescheduleBooking" to """{"ok":true}""")
        FirestoreClient().rescheduleBooking("s1", "a", "b")
        assertNull(lastBody()["overrideBusyConflict"])
        assertNull(lastBody()["overrideVisitConflict"])
    }
    @Test
    fun moveAnywaySendsTheMatchingFlagAndOnlyThat() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("rescheduleBooking" to """{"ok":true}""")
        FirestoreClient().rescheduleBooking("s1", "a", "b", ScheduleOverride.BUSY)
        assertEquals("true", lastBody()["overrideBusyConflict"]!!.jsonPrimitive.content)
        assertNull(lastBody()["overrideVisitConflict"])
        FirestoreClient().rescheduleBooking("s1", "a", "b", ScheduleOverride.VISIT)
        assertEquals("true", lastBody()["overrideVisitConflict"]!!.jsonPrimitive.content)
        assertNull(lastBody()["overrideBusyConflict"])
    }
    @Test
    fun aBusyRefusalOffersTheBusyOverrideWithTheServersSentence() = runBlocking {
        refuse("booking_busy_conflict", "That time is busy on your calendar.")
        val out = FirestoreClient().rescheduleOutcome(attempt())
        assertEquals(RescheduleOutcome.Refused("That time is busy on your calendar.", ScheduleOverride.BUSY), out)
    }
    @Test
    fun anOverlapRefusalOffersTheVisitOverride() = runBlocking {
        refuse("visit_overlap_conflict")
        assertEquals(ScheduleOverride.VISIT, (FirestoreClient().rescheduleOutcome(attempt()) as RescheduleOutcome.Refused).offer)
    }
    @Test
    fun aClosedDayShowsTheMessageOnly() = runBlocking {
        refuse("company_holiday_conflict", "We are closed that day.")
        assertEquals(RescheduleOutcome.Refused("We are closed that day.", null), FirestoreClient().rescheduleOutcome(attempt()))
        refuse(null, "No code at all.")
        assertEquals(RescheduleOutcome.Refused("No code at all.", null), FirestoreClient().rescheduleOutcome(attempt()))
    }
    @Test
    fun theSameOverrideIsNeverOfferedTwice() = runBlocking {
        refuse("visit_overlap_conflict", "Overlaps.")
        val second = FirestoreClient().rescheduleOutcome(attempt(ScheduleOverride.VISIT))
        assertEquals(RescheduleOutcome.Refused("Overlaps.", null), second)
        assertEquals("true", lastBody()["overrideVisitConflict"]!!.jsonPrimitive.content)
    }
    @Test
    fun aSuccessfulMoveIsDone() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("rescheduleBooking" to """{"ok":true}""")
        assertTrue(FirestoreClient().rescheduleOutcome(attempt()) is RescheduleOutcome.Done)
    }
}
