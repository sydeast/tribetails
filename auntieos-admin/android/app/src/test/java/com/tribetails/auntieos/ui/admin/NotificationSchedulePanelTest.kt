package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    /**
     * #1834: the walk read "no send time is set, so none will go out yet" with
     * the switch on, while four visit notices reached the household. The send
     * time governs invoice reminders and overdue notices only.
     */
    @Test
    fun `with sends on and no send time the note says only the two invoice jobs wait`() {
        val note = notificationScheduleNote(live = true, hour = null)
        assertEquals(SCHEDULE_NOTE_ON_NO_HOUR, note)
        assertTrue(note!!.contains("go out as things happen"))
        assertTrue(note.contains("Invoice reminders and overdue notices have no send time"))
        assertFalse(note.contains("none will go out", ignoreCase = true))
    }

    @Test
    fun `with a send time and sends off the note says automatic notices are held back`() {
        val note = notificationScheduleNote(live = false, hour = 9)
        assertEquals(SCHEDULE_NOTE_OFF_WITH_HOUR, note)
        // A broadcast, a single message, an invite and a reset still go.
        assertFalse(note!!.contains("nothing reaches", ignoreCase = true))
    }

    @Test
    fun `a stored hour the picker cannot hold reads as no send time`() {
        assertEquals(SCHEDULE_NOTE_ON_NO_HOUR, notificationScheduleNote(live = true, hour = usableNotificationHour(24)))
        assertNull(notificationScheduleNote(live = false, hour = usableNotificationHour(-1)))
    }

    @Test
    fun `the value line carries the saved switch and send time as values`() {
        assertEquals(
            "Notices to households: on · Invoice reminders: not scheduled · Times are in America/Chicago",
            notificationScheduleDetail(live = true, hour = null, zone = "America/Chicago"),
        )
        assertEquals(
            "Notices to households: off · Invoice reminders: 2:00 PM · Times are in America/Chicago",
            notificationScheduleDetail(live = false, hour = 14, zone = "America/Chicago"),
        )
        assertEquals(
            "Notices to households: on · Invoice reminders: 12:00 AM · Times are in America/Chicago",
            notificationScheduleDetail(live = true, hour = 0, zone = "America/Chicago"),
        )
    }

    @Test
    fun `the switch line says what off holds back and what still goes`() {
        assertTrue(HOUSEHOLD_SWITCH_TIP.contains("automatic notices to households are held back"))
        assertTrue(HOUSEHOLD_SWITCH_TIP.contains("a broadcast, a single message, an invite, a password reset"))
        assertFalse(HOUSEHOLD_SWITCH_TIP.contains("nothing is sent", ignoreCase = true))
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
