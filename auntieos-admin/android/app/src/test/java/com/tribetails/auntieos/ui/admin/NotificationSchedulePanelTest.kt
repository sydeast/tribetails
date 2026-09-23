package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The notification schedule panel's decisions, away from Compose.
 *
 * The panel itself is Compose and is not exercised by this JVM suite, which is
 * exactly why every decision it makes lives in a pure function rather than
 * inside a composable. The same arrangement `BusinessRulesPanelsTest` describes.
 *
 * The values these functions produce have to agree with the React admin's
 * (`NotificationScheduleSection.tsx`) and with the server's `resolveSendHour`,
 * because all three read one document. Where they could drift, the test says so.
 */
class NotificationSchedulePanelTest {

    @Test
    fun `hours read as a person would say them`() {
        assertEquals("12:00 AM", notificationHourLabel(0))
        assertEquals("9:00 AM", notificationHourLabel(9))
        assertEquals("12:00 PM", notificationHourLabel(12))
        assertEquals("1:00 PM", notificationHourLabel(13))
        assertEquals("11:00 PM", notificationHourLabel(23))
    }

    /**
     * Not scheduled is IN the list, not an empty state beside it. An operator who
     * scheduled a job has to be able to unschedule it from the same control.
     */
    @Test
    fun `the picker offers not-scheduled first, then all 24 hours`() {
        assertEquals(25, NOTIFICATION_HOUR_OPTIONS.size)
        assertNull(NOTIFICATION_HOUR_OPTIONS.first())
        assertEquals((0..23).toList(), NOTIFICATION_HOUR_OPTIONS.drop(1))
    }

    /**
     * `firestore.rules` stops every client writing an out-of-range hour, but it
     * cannot stop the Firestore console. The server reads such a value as no
     * cadence, so the panel shows it that way rather than putting a value in the
     * picker that is not one of its own options.
     */
    @Test
    fun `a stored hour the picker cannot show reads as not scheduled`() {
        assertNull(usableNotificationHour(null))
        assertNull(usableNotificationHour(-1))
        assertNull(usableNotificationHour(24))
        assertEquals(0, usableNotificationHour(0))
        assertEquals(23, usableNotificationHour(23))
    }

    /** Midnight is a real choice and must survive the coercion. */
    @Test
    fun `midnight is not mistaken for not scheduled`() {
        assertNotNull(usableNotificationHour(0))
        assertTrue(NOTIFICATION_HOUR_OPTIONS.contains(0))
    }

    @Test
    fun `the note names sending that cannot happen`() {
        val note = notificationScheduleNote(live = true, hour = null)
        assertNotNull(note)
        assertTrue(note!!.contains("no send time is set"))
    }

    @Test
    fun `the note names a time that reaches nobody`() {
        val note = notificationScheduleNote(live = false, hour = 9)
        assertNotNull(note)
        assertTrue(note!!.contains("household notices are off"))
    }

    @Test
    fun `the note stays quiet when the switch and the hour agree`() {
        assertNull(notificationScheduleNote(live = true, hour = 9))
        assertNull(notificationScheduleNote(live = false, hour = null))
    }

    /**
     * THE SHIPPED STATE. Both jobs unscheduled and the gate shut, so the panel
     * opens saying nothing is running, which is what the ruling asks for.
     */
    @Test
    fun `an unconfigured document opens the panel with nothing scheduled`() {
        val s = BusinessSettings()
        assertNull(usableNotificationHour(s.householdNotificationHour))
        assertNull(usableNotificationHour(s.scheduleDigestHour))
        assertNull(notificationScheduleNote(s.householdNotificationsLive, s.householdNotificationHour))
    }
}
