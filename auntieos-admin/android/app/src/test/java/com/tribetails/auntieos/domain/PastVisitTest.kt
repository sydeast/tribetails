package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/** #1574: the same three windows the server names, and the same sentences. */
class PastVisitTest {

    private val now = LocalDateTime.parse("2026-06-02T12:00:00")
    private fun at(s: String) = LocalDateTime.parse(s)

    @Test
    fun `names the three windows`() {
        assertEquals(VisitWindowTiming.AHEAD, classifyVisitWindow(at("2026-06-02T13:00:00"), at("2026-06-02T14:00:00"), now))
        assertEquals(VisitWindowTiming.ENDED, classifyVisitWindow(at("2026-06-02T10:00:00"), at("2026-06-02T11:00:00"), now))
        assertEquals(VisitWindowTiming.UNDERWAY, classifyVisitWindow(at("2026-06-02T11:00:00"), at("2026-06-02T13:00:00"), now))
    }

    @Test
    fun `a start exactly at now is ahead, an end exactly at now has ended`() {
        assertEquals(VisitWindowTiming.AHEAD, classifyVisitWindow(now, now.plusHours(1), now))
        assertEquals(VisitWindowTiming.ENDED, classifyVisitWindow(now.minusHours(1), now, now))
        assertEquals(VisitWindowTiming.ENDED, classifyVisitWindow(now.minusHours(1), null, now))
    }

    @Test
    fun `New visit reads a date and two clock times`() {
        assertEquals(
            VisitWindowTiming.ENDED,
            newVisitTiming(LocalDate.parse("2025-11-01"), LocalTime.parse("09:00"), LocalTime.parse("09:30"), now),
        )
    }

    @Test
    fun `a move into the past is refused with the server sentence, an unreadable start is left alone`() {
        assertEquals(RESCHEDULE_IN_PAST_MESSAGE, rescheduleIntoPastRefusal("2026-06-02T11:59:00", now))
        assertNull(rescheduleIntoPastRefusal("2026-06-02T12:00:00", now))
        assertNull(rescheduleIntoPastRefusal("whenever", now))
    }

    @Test
    fun `a business wall clock becomes the UTC instant the web sends`() {
        assertEquals(
            "2026-05-20T14:00:00Z",
            wallClockToUtcIso(LocalDate.parse("2026-05-20"), LocalTime.parse("09:00"), ZoneId.of("America/Chicago")),
        )
    }

    /** The sentences the form shows are the server's own: read its file. */
    @Test
    fun `the sentences match the server`() {
        var dir: File? = File("").absoluteFile
        while (dir != null && !(File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory)) dir = dir.parentFile
        val server = File(dir ?: error("repo root not found"), "mytribe/functions/src/lib/pastVisit.ts")
        assertTrue("server module missing at ${server.absolutePath}", server.isFile)
        val flat = server.readText().replace(Regex("\\s*\\n\\s*"), " ")
        for (sentence in listOf(RESCHEDULE_IN_PAST_MESSAGE, VISIT_UNDERWAY_MESSAGE)) {
            assertTrue("server does not send: $sentence", flat.contains("'$sentence'"))
        }
    }
}
