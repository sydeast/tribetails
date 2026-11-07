package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1574, operator ruling 2026-11-05: a visit created with a past date is
 * allowed only as already Completed, never Scheduled; moving an existing visit
 * into the past stays blocked. Same three windows and sentences as the server.
 */
class PastVisitTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val chicago = TimeZone.of("America/Chicago")

    /** 2026-06-02 17:00Z, which is 12:00 in Chicago (CDT). */
    private val now = 1_780_419_600_000L

    @Test
    fun theClockFixtureIsNoonInChicago() {
        assertEquals(now, visitTimeMs("2026-06-02T12:00:00", chicago))
        assertEquals(now, visitTimeMs("2026-06-02T17:00:00Z", chicago))
    }

    @Test
    fun namesTheThreeWindowsOnTheBusinessClock() {
        assertEquals(VisitWindowTiming.AHEAD, timingOf("2026-06-02T13:00:00" to "2026-06-02T14:00:00", chicago, now))
        assertEquals(VisitWindowTiming.ENDED, timingOf("2026-06-02T10:00:00" to "2026-06-02T11:00:00", chicago, now))
        assertEquals(VisitWindowTiming.UNDERWAY, timingOf("2026-06-02T11:00:00" to "2026-06-02T13:00:00", chicago, now))
        assertNull(timingOf("soon" to "later", chicago, now))
    }

    @Test
    fun aStartExactlyAtNowIsAheadAndAnEndExactlyAtNowHasEnded() {
        assertEquals(VisitWindowTiming.AHEAD, classifyVisitWindow(now, now + 1, now))
        assertEquals(VisitWindowTiming.ENDED, classifyVisitWindow(now - 1, now, now))
        assertEquals(VisitWindowTiming.ENDED, classifyVisitWindow(now - 1, null, now))
    }

    @Test
    fun aMoveIntoThePastIsRefusedWithTheServerSentence() {
        assertEquals(RESCHEDULE_IN_PAST_MESSAGE, rescheduleIntoPastRefusal("2026-06-02T11:59:00", chicago, now))
        assertNull(rescheduleIntoPastRefusal("2026-06-02T12:00:00", chicago, now))
        assertNull(rescheduleIntoPastRefusal("whenever", chicago, now))
    }

    @Test
    fun recordAsCompletedIsSentOnlyWhenAsked() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createKinCareSession" to """{"ok":true,"sessionId":"s9"}""")
        FirestoreClient().createKinCareSession("kf1", emptyList(), "30Minute", "2026-05-20T09:00:00", "2026-05-20T09:30:00", 30, "")
        assertNull(lastBody()["recordAsCompleted"])
        FirestoreClient().createKinCareSession(
            "kf1", emptyList(), "30Minute", "2026-05-20T09:00:00", "2026-05-20T09:30:00", 30, "", recordAsCompleted = true,
        )
        assertEquals("true", lastBody()["recordAsCompleted"]?.jsonPrimitive?.content)
    }

    @Test
    fun theSentencesMatchTheServer() {
        var dir: File? = File("").absoluteFile
        while (dir != null && !(File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory)) dir = dir.parentFile
        val server = File(dir ?: error("repo root not found"), "mytribe/functions/src/lib/pastVisit.ts")
        assertTrue(server.isFile, "server module missing at ${server.absolutePath}")
        val flat = server.readText().replace(Regex("\\s*\\n\\s*"), " ")
        for (sentence in listOf(RESCHEDULE_IN_PAST_MESSAGE, VISIT_UNDERWAY_MESSAGE)) {
            assertTrue(flat.contains("'$sentence'"), "server does not send: $sentence")
        }
    }

    private fun lastBody() = Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.last().second).jsonObject
}
