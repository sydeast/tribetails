package com.tribetails.auntieos.web.screens.schedule

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone

/** #1592: the walk's "[2026-11-05T21:32:52Z]" stamps read in the business's clock, as on web (#1676). */
@OptIn(ExperimentalTime::class)
class VisitNoteStampsTest {
    private val chicago = TimeZone.of("America/Chicago")
    private val now = Instant.parse("2026-11-07T12:00:00Z")

    @Test
    fun aStampReadsInChicagoTime() {
        assertEquals(
            "[Nov 5, 3:32 PM] (office) Gate code changed",
            readableVisitNotesAt("[2026-11-05T21:32:52Z] (office) Gate code changed", chicago, now),
        )
    }

    @Test
    fun aPastYearStampCarriesTheYear() {
        assertEquals("[Dec 31, 2025, 6:00 PM] (field) Fed", readableVisitNotesAt("[2026-01-01T00:00:00Z] (field) Fed", chicago, now))
    }

    @Test
    fun everyStampIsReadAndOtherTextIsLeftAlone() {
        val notes = "[2026-11-05T13:05:00Z] (field) Walked\n[2026-11-05T21:32:52Z] (office) Called [not a stamp]"
        assertEquals(
            "[Nov 5, 7:05 AM] (field) Walked\n[Nov 5, 3:32 PM] (office) Called [not a stamp]",
            readableVisitNotesAt(notes, chicago, now),
        )
    }
}
