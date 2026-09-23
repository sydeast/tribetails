package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.businessSettingsChangedFields
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The notification schedule panel's decisions, and the diff that carries them.
 *
 * The panel is Compose and not exercised here, which is why every decision it
 * makes lives in a pure function rather than inside a composable, the same
 * arrangement `BusinessRulesPanelsTest` describes.
 *
 * These values have to agree with the React admin's
 * (`NotificationScheduleSection.tsx`), admin Android's, and the server's
 * `resolveSendHour`, because all four read one document.
 */
class NotificationSchedulePanelTest {

    /** Mirrors `jsonOut` in `FirestoreInterop.jvm.kt`, which is what the write uses. */
    private val codec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

    private val loaded = BusinessSettings(
        _id = "business_settings",
        businessName = "Tribe Tails",
        timeZone = "America/Chicago",
        updatedAt = "2026-01-01T00:00:00Z",
        updatedBy = "auntie",
    )

    // ── the shipped state ───────────────────────────────────────────────────

    /**
     * OPERATOR RULING 2026-09-22: no job runs until it is switched on from this
     * UI and the cadence is decided then. A default of 9 here would start the
     * invoice crons at an hour nobody picked.
     */
    @Test
    fun `an unconfigured document is off and has no cadence`() {
        val s = BusinessSettings()
        assertFalse(s.householdNotificationsLive)
        assertNull(s.householdNotificationHour)
        assertNull(s.scheduleDigestHour)
    }

    // ── the pure helpers ────────────────────────────────────────────────────

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
     * The read codec carries no `coerceInputValues` and `firestore.rules` cannot
     * police the Firestore console, so a hand-edited 25 can reach this model. The
     * server reads it as no cadence, so the panel shows it that way rather than
     * putting a value in the picker that is not one of its own options.
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
    fun `the note names sending that cannot happen, and a time that reaches nobody`() {
        assertTrue(notificationScheduleNote(live = true, hour = null)!!.contains("no send time is set"))
        assertTrue(notificationScheduleNote(live = false, hour = 9)!!.contains("household notices are off"))
    }

    @Test
    fun `the note stays quiet when the switch and the hour agree`() {
        assertNull(notificationScheduleNote(live = true, hour = 9))
        assertNull(notificationScheduleNote(live = false, hour = null))
    }

    // ── the diff write ──────────────────────────────────────────────────────

    @Test
    fun `setting a send hour writes only that field`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(householdNotificationHour = 9), codec)
        assertEquals(setOf("householdNotificationHour"), changes.keys)
        assertEquals(JsonPrimitive(9), changes["householdNotificationHour"])
    }

    /**
     * THE ONE THAT MATTERS. Clearing 9 back to null is how the operator stops a
     * job, so it has to arrive as a written null rather than be dropped as
     * "nothing to say". A diff that skipped nulls would leave the job running at
     * 9 while the picker read Not scheduled, which is the quietest possible way
     * to keep sending.
     *
     * `firestore.rules` allows null on exactly these two fields so that this
     * write is not refused; see `bsHourOrNull`.
     */
    @Test
    fun `clearing a send hour writes an explicit null`() {
        val scheduled = loaded.copy(householdNotificationHour = 9)
        val changes = businessSettingsChangedFields(scheduled, scheduled.copy(householdNotificationHour = null), codec)
        assertEquals(setOf("householdNotificationHour"), changes.keys)
        assertEquals(JsonNull, changes["householdNotificationHour"])
    }

    /** Midnight is a change from not scheduled, not an accidental equality. */
    @Test
    fun `midnight diffs as a real change`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(scheduleDigestHour = 0), codec)
        assertEquals(setOf("scheduleDigestHour"), changes.keys)
        assertEquals(JsonPrimitive(0), changes["scheduleDigestHour"])
    }

    /** The two hours are independent, so moving one never writes the other. */
    @Test
    fun `the digest hour and the household hour do not move together`() {
        val changes = businessSettingsChangedFields(loaded, loaded.copy(scheduleDigestHour = 7), codec)
        assertEquals(setOf("scheduleDigestHour"), changes.keys)
    }

    @Test
    fun `the household send gate diffs both ways`() {
        val opened = loaded.copy(householdNotificationsLive = true)
        assertEquals(
            mapOf("householdNotificationsLive" to JsonPrimitive(true)),
            businessSettingsChangedFields(loaded, opened, codec),
        )
        assertEquals(
            mapOf("householdNotificationsLive" to JsonPrimitive(false)),
            businessSettingsChangedFields(opened, opened.copy(householdNotificationsLive = false), codec),
        )
    }

    /**
     * THE REBUILD TRAP, stated as a test. The save overlays onto the loaded
     * document; a default-constructed model would name every field it differs on
     * and write the Kotlin defaults over the operator's document.
     */
    @Test
    fun `a rebuilt model would clobber, which is why the panel copies the loaded one`() {
        val rebuilt = BusinessSettings(
            householdNotificationsLive = true,
            householdNotificationHour = 9,
            scheduleDigestHour = 7,
        )
        assertTrue(businessSettingsChangedFields(loaded, rebuilt, codec).keys.size > 3)

        val overlaid = loaded.copy(
            householdNotificationsLive = true,
            householdNotificationHour = 9,
            scheduleDigestHour = 7,
        )
        assertEquals(
            setOf("householdNotificationsLive", "householdNotificationHour", "scheduleDigestHour"),
            businessSettingsChangedFields(loaded, overlaid, codec).keys,
        )
    }

    /** A null hour has to survive encode and decode, or a saved "not scheduled" comes back wrong. */
    @Test
    fun `both hours round-trip, null and set`() {
        val json = Json { ignoreUnknownKeys = true }
        for (original in listOf(
            BusinessSettings(),
            loaded.copy(householdNotificationHour = 0, scheduleDigestHour = 23, householdNotificationsLive = true),
            loaded.copy(householdNotificationHour = 9, scheduleDigestHour = null),
        )) {
            val text = json.encodeToString(BusinessSettings.serializer(), original)
            assertEquals(original, json.decodeFromString(BusinessSettings.serializer(), text))
        }
    }

    /** A document written before these fields existed decodes to the shipped state. */
    @Test
    fun `a document missing the keys decodes to off and unscheduled`() {
        val parsed = Json { ignoreUnknownKeys = true }
            .decodeFromString(BusinessSettings.serializer(), """{"_id":"business_settings"}""")
        assertFalse(parsed.householdNotificationsLive)
        assertNull(parsed.householdNotificationHour)
        assertNull(parsed.scheduleDigestHour)
    }
}
