package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ruling on #2382 (2026-11-20): payment, invoice, KinTale and booking
 * confirmations are required on and cannot be disabled. The server marks the
 * five rows with `lockedOnStreams: { kinfolk: true }`, refuses a save that
 * turns their Kinfolk copy or its email off, and ignores an off already stored.
 * The Android gate draws them locked on, and saves them with the Kinfolk copy
 * kept on so an old stored off cannot make every later edit fail.
 */
class NotificationConfirmationLockTest {

    private val locked = NotificationCatalogEntry(
        key = "invoice.new",
        label = "New invoice or quote issued",
        audience = "both",
        allowedChannels = listOf("email", "sms", "push"),
        required = mapOf("email" to true),
        alwaysEnabled = true,
        alwaysEnabledStreams = setOf("kinfolk"),
        lockedOnStreams = setOf("kinfolk"),
        audiences = setOf("business", "kinfolk"),
    )
    private val open = locked.copy(key = "kincare.booking.cancel", lockedOnStreams = emptySet())

    @Test
    fun parsesLockedOnStreams_andItsAbsenceAsNoLock() {
        val parsed = notificationCatalogEntryFromMap(
            mapOf("key" to "invoice.new", "lockedOnStreams" to mapOf("kinfolk" to true, "business" to false)),
        )!!
        assertEquals(setOf("kinfolk"), parsed.lockedOnStreams)
        assertEquals(emptySet<String>(), notificationCatalogEntryFromMap(mapOf("key" to "k"))!!.lockedOnStreams)
    }

    @Test
    fun lockedForTheKinfolkCopyOnly_emailBeingThePinnedChannel() {
        assertTrue(locked.lockedOnFor("kinfolk"))
        assertFalse(locked.lockedOnFor("business"))
        assertTrue(locked.lockedOnChannel("kinfolk", "email"))
        assertFalse(locked.lockedOnChannel("kinfolk", "sms"))
        assertFalse(locked.lockedOnChannel("business", "email"))
        assertFalse(open.lockedOnFor("kinfolk"))
    }

    @Test
    fun badgeSaysRequiredForKinfolk_neverTheAdvisoryWords() {
        for (enabled in listOf(true, false)) {
            val badge = notifAlwaysOnBadge(locked, "kinfolk", enabled)!!
            assertEquals(NOTIF_REQUIRED_FOR_KINFOLK, badge.label)
            assertEquals(NOTIF_REQUIRED_FOR_KINFOLK_DETAIL, badge.detail)
            assertFalse(badge.detail.lowercase().contains("you can switch it off"))
        }
        // The owner's copy of the same row carries no lock badge.
        assertNull(notifAlwaysOnBadge(locked, "business", true))
        // Another always-on row stays advisory.
        assertEquals(NOTIF_MEANT_TO_STAY_ON, notifAlwaysOnBadge(open, "kinfolk", true)!!.label)
    }

    @Test
    fun wordingMatchesTheServerRefusal_andPromisesNoDelivery() {
        assertEquals(
            "Payment, invoice, KinTale and booking confirmations cannot be turned off for Kinfolk, " +
                "and neither can their email. Text and push can still be changed.",
            NOTIF_REQUIRED_FOR_KINFOLK_DETAIL,
        )
        val words = "$NOTIF_REQUIRED_FOR_KINFOLK $NOTIF_REQUIRED_FOR_KINFOLK_DETAIL".lowercase()
        assertFalse(words.contains("always on"))
        assertFalse(words.contains("—"))
    }

    @Test
    fun keptLockedOn_savesAnOldFlatOffWithTheKinfolkCopyAndEmailOn() {
        val stored = NotificationOverride(enabled = false, channels = mapOf("email" to false, "sms" to false))
        val next = stored.keptLockedOn(locked)
        assertEquals(true, next.streams["kinfolk"]?.enabled)
        assertEquals(true, next.streams["kinfolk"]?.channels?.get("email"))
        // The owner's copy and text keep exactly what the operator chose.
        assertFalse(next.enabled)
        assertEquals(false, next.channels["sms"])
    }

    @Test
    fun keptLockedOn_turnsAStoredKinfolkOverlayOffBackOn() {
        val stored = NotificationOverride(
            streams = mapOf("kinfolk" to StreamGate(enabled = false, channels = mapOf("email" to false, "push" to false))),
        )
        val next = stored.keptLockedOn(locked)
        assertEquals(true, next.streams["kinfolk"]?.enabled)
        assertEquals(mapOf("email" to true, "push" to false), next.streams["kinfolk"]?.channels)
    }

    @Test
    fun keptLockedOn_leavesAnOnOverrideAndAnUnlockedRowAlone() {
        val ownerOff = NotificationOverride(streams = mapOf("business" to StreamGate(enabled = false)))
        assertSame(ownerOff, ownerOff.keptLockedOn(locked))
        val off = NotificationOverride(enabled = false)
        assertSame(off, off.keptLockedOn(open))
    }
}
