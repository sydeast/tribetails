package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * #574: every refusal here is a defect that shipped.
 *
 * The Save Block button read
 * `runCatching { LocalDate.parse(selectedDate) }.getOrNull() ?: LocalDate.now()`
 * and then handed the two clock fields straight on, unparsed and unordered. So a
 * typo in the date blocked out TODAY instead, an end before the start was
 * writable, and a `SPECIFIC_TIME` mode wrote a zero-length window. Nothing was
 * checked before the write went out.
 */
class BlockTimeFormTest {

    /** Fixed zone so the epoch-ms twin is a number this test can name. */
    private val chicago = ZoneId.of("America/Chicago")

    private fun ok(result: BlockWindowResult): BlockWindow {
        assertTrue("expected a window, got $result", result is BlockWindowResult.Ok)
        return (result as BlockWindowResult.Ok).window
    }

    private fun problem(result: BlockWindowResult): String {
        assertTrue("expected a refusal, got $result", result is BlockWindowResult.Problem)
        return (result as BlockWindowResult.Problem).message
    }

    // ── the date ─────────────────────────────────────────────────────────────

    /**
     * THE DEFECT THIS FILE EXISTS FOR. `?: LocalDate.now()` turned an
     * unparseable date into today, silently: the operator asked to block one day
     * and blocked another, on a day they may well have been working.
     */
    @Test
    fun `an unparseable date is refused, never quietly turned into today`() {
        val message = problem(
            resolveBlockWindow("next tuesday", "09:00", "12:00", "", BlockMode.TIME_BLOCK, chicago),
        )
        assertTrue("the refusal must quote what was typed: $message", message.contains("next tuesday"))
    }

    @Test
    fun `a date that looks right but does not exist is refused too`() {
        problem(resolveBlockWindow("2026-02-30", "09:00", "12:00", "", BlockMode.TIME_BLOCK, chicago))
    }

    @Test
    fun `a blank date is refused`() {
        problem(resolveBlockWindow("", "09:00", "12:00", "", BlockMode.TIME_BLOCK, chicago))
    }

    // ── the clock ────────────────────────────────────────────────────────────

    @Test
    fun `an end before the start is refused`() {
        assertEquals(
            "The end has to come after the start.",
            problem(resolveBlockWindow("2026-08-24", "17:00", "09:00", "", BlockMode.TIME_BLOCK, chicago)),
        )
    }

    /**
     * A zero-length window is what `SPECIFIC_TIME` used to produce. The server
     * refuses `startTime >= endTime`, so it could never have landed either.
     */
    @Test
    fun `a zero-length window is refused`() {
        assertEquals(
            "The end has to come after the start.",
            problem(resolveBlockWindow("2026-08-24", "09:00", "09:00", "", BlockMode.TIME_BLOCK, chicago)),
        )
    }

    @Test
    fun `a clock that is not 24-hour HHmm is refused, by field`() {
        assertTrue(
            problem(resolveBlockWindow("2026-08-24", "9am", "12:00", "", BlockMode.TIME_BLOCK, chicago))
                .startsWith("Start time"),
        )
        assertTrue(
            problem(resolveBlockWindow("2026-08-24", "09:00", "5pm", "", BlockMode.TIME_BLOCK, chicago))
                .startsWith("End time"),
        )
        problem(resolveBlockWindow("2026-08-24", "24:00", "25:00", "", BlockMode.TIME_BLOCK, chicago))
        problem(resolveBlockWindow("2026-08-24", "9:00", "12:00", "", BlockMode.TIME_BLOCK, chicago))
    }

    /**
     * The string compare the server also makes is only safe because the regex
     * above forces two-digit, zero-padded hours: unpadded, "9:00" would sort
     * after "17:00".
     */
    @Test
    fun `the ordering check is not fooled by hour width, because unpadded is refused first`() {
        problem(resolveBlockWindow("2026-08-24", "9:00", "17:00", "", BlockMode.TIME_BLOCK, chicago))
    }

    // ── what a good window carries ───────────────────────────────────────────

    @Test
    fun `a time block carries the wall clock and the epoch-ms twin of the same window`() {
        val w = ok(resolveBlockWindow("2026-08-24", " 09:00 ", " 12:00 ", "  Vet  ", BlockMode.TIME_BLOCK, chicago))

        assertEquals("2026-08-24", w.date)
        assertEquals("09:00", w.startTime)
        assertEquals("12:00", w.endTime)
        assertEquals("Vet", w.notes)
        // 2026-08-24 is CDT (UTC-5): 09:00 local is 14:00Z.
        assertEquals(java.time.Instant.parse("2026-08-24T14:00:00Z").toEpochMilli(), w.startTimeMs)
        assertEquals(java.time.Instant.parse("2026-08-24T17:00:00Z").toEpochMilli(), w.endTimeMs)
        assertTrue("the twin must describe the same window", w.startTimeMs < w.endTimeMs)
    }

    /**
     * Whole day ignores the clock fields entirely, which is why the screen hides
     * them in that mode: 23:59 is the last minute the collection's `HH:mm` shape
     * can express, and the server's own regex tops out there.
     */
    @Test
    fun `whole day is 0000 to 2359 whatever the clock fields say`() {
        val w = ok(resolveBlockWindow("2026-08-24", "17:00", "09:00", "Vacation", BlockMode.WHOLE_DAY, chicago))

        assertEquals("00:00", w.startTime)
        assertEquals("23:59", w.endTime)
        assertTrue(w.startTimeMs < w.endTimeMs)
    }

    /**
     * Two modes, not three: the deleted `SPECIFIC_TIME` resolved to
     * `startTime to startTime`, a window of no length, which nothing can block
     * and the server refuses outright.
     */
    @Test
    fun `there is no mode that can produce a zero-length window`() {
        assertEquals(listOf(BlockMode.WHOLE_DAY, BlockMode.TIME_BLOCK), BlockMode.entries.toList())
        BlockMode.entries.forEach { mode ->
            val w = ok(resolveBlockWindow("2026-08-24", "09:00", "12:00", "", mode, chicago))
            assertTrue("$mode produced a zero-length window", w.startTime < w.endTime)
            assertTrue("$mode produced a zero-length instant window", w.startTimeMs < w.endTimeMs)
        }
    }
}
