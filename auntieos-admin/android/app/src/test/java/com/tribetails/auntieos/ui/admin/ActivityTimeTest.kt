package com.tribetails.auntieos.ui.admin
import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.model.businessZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
/**
 * #1585: the Activity Log read UTC stamps as local time and grouped days by UTC.
 * The business runs on America/Chicago; these pin the reading, DST included.
 */
class ActivityTimeTest {
    private val chicago = businessZone("America/Chicago")
    @Test
    fun readsAUtcStampOnTheChicagoClockInStandardTime() {
        assertEquals(ActivityWhen("2026-11-04", "3:34p"), activityWhen("2026-11-04T21:34:00Z", chicago))
    }
    @Test
    fun readsItInDaylightTimeToo() {
        assertEquals(ActivityWhen("2026-07-16", "4:34p"), activityWhen("2026-07-16T21:34:00Z", chicago))
    }
    @Test
    fun movesTheDayBackWhenUtcHasAlreadyRolledOver() {
        assertEquals(ActivityWhen("2026-11-04", "8:34p"), activityWhen("2026-11-05T02:34:00.123Z", chicago))
    }
    @Test
    fun movesTheDayForwardWhenTheZoneIsAheadOfUtc() {
        assertEquals(ActivityWhen("2026-11-05", "8:30a"), activityWhen("2026-11-04T23:30:00Z", businessZone("Asia/Tokyo")))
    }
    @Test
    fun readsAnOffsetStampAsTheInstantItNames() {
        assertEquals("3:34p", activityWhen("2026-11-04T16:34:00-05:00", chicago)?.clock)
    }
    @Test
    fun keepsAZonelessStampAsTheBusinessWallClock() {
        assertEquals(ActivityWhen("2026-11-04", "9:00a"), activityWhen("2026-11-04T09:00:00", chicago))
    }
    @Test
    fun twelveOClockReadsAsTwelve() {
        assertEquals("12:05a", activityWhen("2026-11-04T06:05:00Z", chicago)?.clock)
        assertEquals("12:05p", activityWhen("2026-11-04T18:05:00Z", chicago)?.clock)
    }
    @Test
    fun returnsNullForAStampWithNoReadableTime() {
        assertNull(activityWhen("", chicago))
        assertNull(activityWhen("2026-11-04", chicago))
        assertNull(activityWhen("not a date", chicago))
    }
    @Test
    fun theOpenedEntryShowsTheBusinessReadingBesideTheRawStamp() {
        val rows = activityDetailRows(
            ActivityLogEntry(id = "a1", timestamp = "2026-11-04T21:34:00Z", actionType = "LOGIN"),
            chicago,
        )
        assertEquals("When" to "2026-11-04T21:34:00Z", rows[0])
        assertEquals("Business time" to "2026-11-04 3:34p", rows[1])
    }
}
