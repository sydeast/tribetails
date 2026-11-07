package com.tribetails.auntieos.web.screens.activity
import com.tribetails.auntieos.web.screens.booking.NewBookingMath
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1585: the Activity Log read UTC stamps as local time and grouped days by UTC.
 * The business runs on America/Chicago; these pin the reading, DST included.
 */
class ActivityTimeTest {
    private val chicago = NewBookingMath.businessTimeZone("America/Chicago")
    @Test
    fun readsAUtcStampOnTheChicagoClockInStandardTime() {
        assertEquals(ActivityWhen("2026-11-04", "15:34"), activityWhen("2026-11-04T21:34:00Z", chicago))
    }
    @Test
    fun readsItInDaylightTimeToo() {
        assertEquals(ActivityWhen("2026-07-16", "16:34"), activityWhen("2026-07-16T21:34:00Z", chicago))
    }
    @Test
    fun movesTheDayBackWhenUtcHasAlreadyRolledOver() {
        assertEquals(ActivityWhen("2026-11-04", "20:34"), activityWhen("2026-11-05T02:34:00.123Z", chicago))
    }
    @Test
    fun movesTheDayForwardWhenTheZoneIsAheadOfUtc() {
        val tokyo = NewBookingMath.businessTimeZone("Asia/Tokyo")
        assertEquals(ActivityWhen("2026-11-05", "08:30"), activityWhen("2026-11-04T23:30:00Z", tokyo))
    }
    @Test
    fun readsAnOffsetStampAsTheInstantItNames() {
        assertEquals("15:34", activityWhen("2026-11-04T16:34:00-05:00", chicago)?.clock)
    }
    @Test
    fun keepsAZonelessStampAsTheBusinessWallClock() {
        assertEquals(ActivityWhen("2026-11-04", "09:00"), activityWhen("2026-11-04T09:00:00", chicago))
    }
    @Test
    fun anUnsetOrUnreadableZoneIsChicagoNotTheMachine() {
        assertEquals("15:34", activityWhen("2026-11-04T21:34:00Z", NewBookingMath.businessTimeZone(null))?.clock)
        assertEquals("15:34", activityWhen("2026-11-04T21:34:00Z", NewBookingMath.businessTimeZone("Nowhere/Land"))?.clock)
    }
    @Test
    fun returnsNullForAStampWithNoReadableTime() {
        assertNull(activityWhen("", chicago))
        assertNull(activityWhen("2026-11-04", chicago))
        assertNull(activityWhen("not a date", chicago))
    }
}
