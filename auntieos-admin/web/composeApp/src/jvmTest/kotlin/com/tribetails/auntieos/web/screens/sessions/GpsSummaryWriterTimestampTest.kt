package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * ISSUE #615. `buildGpsSummary` used to convert every breadcrumb clock with a
 * private ISO-only parser that ended `.getOrDefault(0L)`. `0L` is not a neutral
 * failure value: `GpsPoint` documents it as the "clock unknown" sentinel, and
 * the readers collapsed onto it in #610/#614 honour it as fact. So every Android
 * breadcrumb — which carries epoch millis, not an ISO string, since the wasm
 * writer was retired in #513 — would have been stored as a point whose clock was
 * genuinely unknown, and believed.
 *
 * These pin the two halves of the repair: the parser takes both shapes and
 * returns null rather than zero when it takes neither, and the single call site
 * in `buildGpsSummary` is where null becomes the sentinel.
 *
 * The writer does not execute on any shipping target today — both platform
 * functions it needs are jvm stubs, which is why #615 is filed as latent. That
 * makes these tests the only thing standing between a future
 * `platformGetBreadcrumbs` actual and a summary whose every point reads 1970.
 */
class GpsSummaryWriterTimestampTest {

    private fun crumb(ts: String, lat: Double = 30.2672, lng: Double = -97.7431) =
        Breadcrumb(_id = ts, timestamp = ts, lat = lat, lng = lng)

    /** 2026-06-04T12:34:56Z, the instant `GpsSummaryAdapterTest` already pins. */
    private val instant = 1_780_576_496_000L

    // ── parseBreadcrumbMillis: both shapes, null on neither ──────────────────

    @Test
    fun androidsEpochMillisAreReadAsTheInstantTheyAre() {
        assertEquals(instant, parseBreadcrumbMillis(instant.toString()))
    }

    @Test
    fun theRetiredWasmClientsIsoStringStillParses() {
        assertEquals(instant, parseBreadcrumbMillis("2026-06-04T12:34:56Z"))
    }

    @Test
    fun aClockThisCannotReadIsAbsentRatherThanZero() {
        assertNull(parseBreadcrumbMillis(""))
        assertNull(parseBreadcrumbMillis("   "))
        assertNull(parseBreadcrumbMillis("yesterday"))
        assertNull(parseBreadcrumbMillis("2026-06-04"))           // too short for the slim ISO form
        assertNull(parseBreadcrumbMillis("1780576496000.5"))      // not integral millis
        assertNull(parseBreadcrumbMillis("99999999999999999999")) // overflows Long
    }

    @Test
    fun epochZeroItselfIsStillReadAsEpochZero() {
        // The sentinel is a value this parser is allowed to return honestly: a
        // breadcrumb whose clock really says 0 is not a parse failure.
        assertEquals(0L, parseBreadcrumbMillis("0"))
    }

    // ── buildGpsSummary: the stored point carries the real instant ───────────

    @Test
    fun aNumericTimestampBreadcrumbIsStoredWithItsRealInstant() {
        val summary = buildGpsSummary(
            listOf(
                crumb(instant.toString()),
                crumb((instant + 60_000L).toString(), lat = 30.2680, lng = -97.7440),
            )
        )
        assertEquals(listOf(instant, instant + 60_000L), summary.route.map { it.t })
        // Duration comes off the same clocks, so it is real too. This read 0 before.
        assertEquals(60L, summary.durationSeconds)
    }

    @Test
    fun anIsoTimestampBreadcrumbIsStoredWithItsRealInstant() {
        val summary = buildGpsSummary(
            listOf(
                crumb("2026-06-04T12:34:56Z"),
                crumb("2026-06-04T12:35:56Z", lat = 30.2680, lng = -97.7440),
            )
        )
        assertEquals(listOf(instant, instant + 60_000L), summary.route.map { it.t })
        assertEquals(60L, summary.durationSeconds)
    }

    @Test
    fun onlyAnUnreadableClockGetsTheUnknownSentinel() {
        val summary = buildGpsSummary(
            listOf(
                crumb(instant.toString()),
                crumb("not a clock", lat = 30.2680, lng = -97.7440),
            )
        )
        // The point is kept: it has a real location, and the sentinel is the
        // wire's own encoding for a clock nobody knows. Dropping it would put a
        // hole in the polyline over a field the map does not draw.
        assertEquals(listOf(instant, 0L), summary.route.map { it.t })
        assertEquals(2, summary.route.size)
    }
}
