package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 15.2 + notification-settings revamp: effective-state, per-stream fallback and
 * lock contract for the notification matrix (pure). Stream-effective values use
 * FIELD-level fallback per the frozen contract: streams[S].enabled ?? flat enabled;
 * streams[S].channels[ch] ?? flat channels[ch]; same for lockedEnabled/locked.
 */
class NotificationMatrixTest {

    private val booking = NotificationCatalogEntry(
        key = "booking.confirmed",
        category = "Bookings",
        allowedChannels = listOf("email", "sms", "push"),
        required = mapOf("email" to true),
        alwaysEnabled = false,
    )
    private val security = NotificationCatalogEntry(
        key = "security.breach",
        category = "Security",
        allowedChannels = listOf("email", "push"),
        alwaysEnabled = true,
    )

    private val matrix = NotificationMatrix(
        catalog = listOf(booking, security),
        overrides = mapOf("booking.confirmed" to NotificationOverride(enabled = true, channels = mapOf("sms" to false))),
    )

    @Test
    fun locksReflectCatalog() {
        assertTrue(booking.channelLocked("email"))   // required
        assertFalse(booking.channelLocked("sms"))
        assertFalse(booking.enabledLocked())
        assertTrue(security.enabledLocked())          // alwaysEnabled
    }

    @Test
    fun alwaysEnabledForScopesByStreams() {
        // Empty alwaysEnabledStreams: applies to every stream the key serves.
        assertTrue(security.alwaysEnabledFor(STREAM_BUSINESS))
        assertTrue(security.alwaysEnabledFor(STREAM_STAFF))
        assertTrue(security.alwaysEnabledFor(STREAM_KINFOLK))
        // Scoped: only the named streams are always-on.
        val scoped = security.copy(alwaysEnabledStreams = setOf(STREAM_KINFOLK))
        assertTrue(scoped.alwaysEnabledFor(STREAM_KINFOLK))
        assertFalse(scoped.alwaysEnabledFor(STREAM_BUSINESS))
        assertFalse(scoped.alwaysEnabledFor(STREAM_STAFF))
        // Not alwaysEnabled at all: false everywhere, scoped or not.
        assertFalse(booking.alwaysEnabledFor(STREAM_BUSINESS))
        assertFalse(booking.copy(alwaysEnabledStreams = setOf(STREAM_BUSINESS)).alwaysEnabledFor(STREAM_BUSINESS))
    }

    @Test
    fun displayTitleFallsBackLabelDescriptionKey() {
        assertEquals(
            "Booking confirmed",
            booking.copy(label = "Booking confirmed", description = "desc").displayTitle(),
        )
        assertEquals("desc", booking.copy(label = "", description = "desc").displayTitle())
        assertEquals("booking.confirmed", booking.copy(label = " ", description = "").displayTitle())
    }

    @Test
    fun effectiveStateAppliesOverrideElseDefaultsOn() {
        assertFalse(matrix.effectiveChannel("booking.confirmed", "sms")) // override off
        assertTrue(matrix.effectiveChannel("booking.confirmed", "email")) // default on
        assertTrue(matrix.effectiveEnabled("booking.confirmed"))
        // No override for security.breach -> defaults on.
        assertTrue(matrix.effectiveEnabled("security.breach"))
        assertTrue(matrix.effectiveChannel("security.breach", "push"))
    }

    @Test
    fun unknownKeyDefaultsOn() {
        assertTrue(matrix.effectiveEnabled("does.not.exist"))
        assertTrue(matrix.effectiveChannel("does.not.exist", "email"))
    }

    // ── stream-effective fallback matrix ─────────────────────────────────────

    private val streamed = NotificationMatrix(
        overrides = mapOf(
            "k" to NotificationOverride(
                enabled = true,
                channels = mapOf("sms" to false),
                lockedEnabled = true,
                locked = mapOf("email" to true),
                streams = mapOf(
                    STREAM_KINFOLK to StreamGate(enabled = false),
                    STREAM_BUSINESS to StreamGate(
                        channels = mapOf("sms" to true),
                        lockedEnabled = false,
                        locked = mapOf("email" to false),
                    ),
                ),
            ),
        ),
    )

    @Test
    fun streamEnabledFallsBackToFlatFieldLevel() {
        assertFalse(streamed.streamEffectiveEnabled("k", STREAM_KINFOLK))   // explicit stream false
        assertTrue(streamed.streamEffectiveEnabled("k", STREAM_BUSINESS))   // stream silent -> flat true
        assertTrue(streamed.streamEffectiveEnabled("k", STREAM_STAFF))      // no stream at all -> flat
    }

    @Test
    fun streamChannelFallsBackPerChannel() {
        assertTrue(streamed.streamEffectiveChannel("k", STREAM_BUSINESS, "sms"))  // explicit stream true
        assertFalse(streamed.streamEffectiveChannel("k", STREAM_KINFOLK, "sms"))  // stream silent -> flat false
        assertTrue(streamed.streamEffectiveChannel("k", STREAM_KINFOLK, "email")) // flat silent -> default on
    }

    @Test
    fun streamLocksFallBackToFlat() {
        assertFalse(streamed.streamEffectiveLockedEnabled("k", STREAM_BUSINESS)) // explicit stream false wins
        assertTrue(streamed.streamEffectiveLockedEnabled("k", STREAM_KINFOLK))   // stream silent -> flat true
        assertFalse(streamed.streamEffectiveChannelLocked("k", STREAM_BUSINESS, "email")) // explicit false
        assertTrue(streamed.streamEffectiveChannelLocked("k", STREAM_KINFOLK, "email"))   // flat lock inherited
        assertFalse(streamed.streamEffectiveChannelLocked("k", STREAM_KINFOLK, "sms"))    // nothing anywhere
    }

    @Test
    fun streamEffectiveUnknownKeyUsesDefaults() {
        assertTrue(streamed.streamEffectiveEnabled("nope", STREAM_KINFOLK))
        assertTrue(streamed.streamEffectiveChannel("nope", STREAM_KINFOLK, "email"))
        assertFalse(streamed.streamEffectiveLockedEnabled("nope", STREAM_KINFOLK))
        assertFalse(streamed.streamEffectiveChannelLocked("nope", STREAM_KINFOLK, "email"))
    }

    @Test
    fun lockReasonForBlankOrMissingIsNull() {
        val m = NotificationMatrix(
            overrides = mapOf(
                "a" to NotificationOverride(lockReason = "Auntie keeps this one on."),
                "b" to NotificationOverride(lockReason = "   "),
            ),
        )
        assertEquals("Auntie keeps this one on.", m.lockReasonFor("a"))
        assertNull(m.lockReasonFor("b"))
        assertNull(m.lockReasonFor("missing"))
    }

    // ── stream write helpers (what the gate UI saves) ────────────────────────

    @Test
    fun withStreamEnabledAndChannelOverlayOnlyThatStream() {
        val o = NotificationOverride()
            .withStreamEnabled(STREAM_KINFOLK, false)
            .withStreamChannel(STREAM_KINFOLK, "push", false)
        assertEquals(false, o.streams[STREAM_KINFOLK]?.enabled)
        assertEquals(mapOf("push" to false), o.streams[STREAM_KINFOLK]?.channels)
        assertNull(o.streams[STREAM_BUSINESS])
        assertTrue(o.enabled) // flat untouched
        val m = NotificationMatrix(overrides = mapOf("k" to o))
        assertFalse(m.streamEffectiveEnabled("k", STREAM_KINFOLK))
        assertTrue(m.streamEffectiveEnabled("k", STREAM_BUSINESS))
    }

    @Test
    fun withStreamLockedEnabledOnLocksOnlyThatStream() {
        val o = NotificationOverride().withStreamLockedEnabled(
            STREAM_KINFOLK, true, allStreams = setOf(STREAM_KINFOLK, STREAM_BUSINESS),
        )
        assertEquals(true, o.streams[STREAM_KINFOLK]?.lockedEnabled)
        assertFalse(o.lockedEnabled)
        assertNull(o.streams[STREAM_BUSINESS])
    }

    @Test
    fun withStreamLockedEnabledOffMigratesFlatLockToOtherStreams() {
        // Locks are only-true on the wire, so unlocking a flat-inherited lock must clear
        // the flat field and pin the lock explicitly onto the OTHER streams instead.
        val o = NotificationOverride(lockedEnabled = true).withStreamLockedEnabled(
            STREAM_BUSINESS, false, allStreams = setOf(STREAM_KINFOLK, STREAM_BUSINESS),
        )
        assertFalse(o.lockedEnabled)
        assertNull(o.streams[STREAM_BUSINESS]?.lockedEnabled)
        assertEquals(true, o.streams[STREAM_KINFOLK]?.lockedEnabled)
        val m = NotificationMatrix(overrides = mapOf("k" to o))
        assertFalse(m.streamEffectiveLockedEnabled("k", STREAM_BUSINESS))
        assertTrue(m.streamEffectiveLockedEnabled("k", STREAM_KINFOLK))
    }

    @Test
    fun withStreamLockedEnabledOffLeavesExplicitStreamValuesAlone() {
        val o = NotificationOverride(
            lockedEnabled = true,
            streams = mapOf(STREAM_KINFOLK to StreamGate(lockedEnabled = false)),
        ).withStreamLockedEnabled(
            STREAM_BUSINESS, false, allStreams = setOf(STREAM_KINFOLK, STREAM_BUSINESS, STREAM_STAFF),
        )
        assertEquals(false, o.streams[STREAM_KINFOLK]?.lockedEnabled) // explicit value untouched
        assertEquals(true, o.streams[STREAM_STAFF]?.lockedEnabled)   // inherited lock materialized
        assertFalse(o.lockedEnabled)
    }

    @Test
    fun withStreamChannelLockOffMigratesFlatChannelLock() {
        val o = NotificationOverride(locked = mapOf("sms" to true)).withStreamChannelLock(
            STREAM_KINFOLK, "sms", false, allStreams = setOf(STREAM_KINFOLK, STREAM_BUSINESS),
        )
        assertTrue(o.locked.isEmpty() || o.locked["sms"] != true)
        assertEquals(true, o.streams[STREAM_BUSINESS]?.locked?.get("sms"))
        val m = NotificationMatrix(overrides = mapOf("k" to o))
        assertFalse(m.streamEffectiveChannelLocked("k", STREAM_KINFOLK, "sms"))
        assertTrue(m.streamEffectiveChannelLocked("k", STREAM_BUSINESS, "sms"))
    }

    @Test
    fun withStreamChannelLockOffWithoutFlatJustRemoves() {
        val o = NotificationOverride(
            streams = mapOf(STREAM_KINFOLK to StreamGate(locked = mapOf("sms" to true))),
        ).withStreamChannelLock(STREAM_KINFOLK, "sms", false, allStreams = setOf(STREAM_KINFOLK))
        assertNull(o.streams[STREAM_KINFOLK]?.locked?.get("sms"))
        assertTrue(o.locked.isEmpty())
        assertFalse(
            NotificationMatrix(overrides = mapOf("k" to o))
                .streamEffectiveChannelLocked("k", STREAM_KINFOLK, "sms"),
        )
    }

    @Test
    fun withStreamChannelLockOnLocksOnlyThatStream() {
        val o = NotificationOverride().withStreamChannelLock(
            STREAM_KINFOLK, "email", true, allStreams = setOf(STREAM_KINFOLK, STREAM_BUSINESS),
        )
        assertEquals(true, o.streams[STREAM_KINFOLK]?.locked?.get("email"))
        assertNull(o.streams[STREAM_BUSINESS])
        assertTrue(o.locked.isEmpty())
    }
}
