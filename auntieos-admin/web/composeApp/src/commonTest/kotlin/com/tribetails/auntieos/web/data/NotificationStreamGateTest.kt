package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Field-level fallback contract for per-stream gate overlays: a stream's value wins
 * per FIELD, anything unset falls back to the flat (legacy) override, and no override
 * at all means catalog defaults. Also pins the write-side toggle helpers, including
 * the unlock materialization (wire lock maps carry literal-true only, so a flat lock
 * is cleared and re-pinned onto the other streams rather than overridden with false).
 */
class NotificationStreamGateTest {

    private fun matrixWith(key: String, override: NotificationOverride?) = NotificationMatrix(
        catalog = listOf(
            NotificationCatalogEntry(
                key = key,
                audiences = setOf("business", "kinfolk"),
                allowedChannels = listOf("email", "sms", "push"),
            ),
        ),
        overrides = if (override == null) emptyMap() else mapOf(key to override),
    )

    @Test
    fun noOverrideMeansCatalogDefaults() {
        val m = matrixWith("k", null)
        assertTrue(streamEffectiveEnabled(m, "k", "business"))
        assertTrue(streamEffectiveChannel(m, "k", "kinfolk", "sms"))
        assertFalse(streamEffectiveLockedEnabled(m, "k", "staff"))
        assertFalse(streamEffectiveChannelLocked(m, "k", "business", "email"))
        assertNull(lockReasonFor(m, "k"))
    }

    @Test
    fun absentStreamFallsBackToFlatWholesale() {
        val m = matrixWith(
            "k",
            NotificationOverride(
                enabled = false,
                channels = mapOf("sms" to false),
                lockedEnabled = true,
                locked = mapOf("email" to true),
            ),
        )
        assertFalse(streamEffectiveEnabled(m, "k", "business"))
        assertFalse(streamEffectiveChannel(m, "k", "business", "sms"))
        assertTrue(streamEffectiveChannel(m, "k", "business", "push"))
        assertTrue(streamEffectiveLockedEnabled(m, "k", "business"))
        assertTrue(streamEffectiveChannelLocked(m, "k", "business", "email"))
    }

    @Test
    fun streamFieldWinsOverFlatFieldByField() {
        val m = matrixWith(
            "k",
            NotificationOverride(
                enabled = false,
                channels = mapOf("sms" to false, "email" to true),
                streams = mapOf("business" to StreamGate(enabled = true, channels = mapOf("email" to false))),
            ),
        )
        assertTrue(streamEffectiveEnabled(m, "k", "business"))            // stream enabled wins
        assertFalse(streamEffectiveEnabled(m, "k", "kinfolk"))            // other stream falls to flat
        assertFalse(streamEffectiveChannel(m, "k", "business", "email"))  // stream channel wins
        assertFalse(streamEffectiveChannel(m, "k", "business", "sms"))    // unset in stream -> flat false
        assertTrue(streamEffectiveChannel(m, "k", "business", "push"))    // unset everywhere -> default on
    }

    @Test
    fun streamLockedEnabledFalseUnlocksOnlyThatStream() {
        val m = matrixWith(
            "k",
            NotificationOverride(
                lockedEnabled = true,
                streams = mapOf("staff" to StreamGate(lockedEnabled = false)),
            ),
        )
        assertFalse(streamEffectiveLockedEnabled(m, "k", "staff"))
        assertTrue(streamEffectiveLockedEnabled(m, "k", "business"))
    }

    @Test
    fun streamChannelLocksFallBackPerChannel() {
        val m = matrixWith(
            "k",
            NotificationOverride(
                locked = mapOf("email" to true),
                streams = mapOf("kinfolk" to StreamGate(locked = mapOf("sms" to true))),
            ),
        )
        assertTrue(streamEffectiveChannelLocked(m, "k", "kinfolk", "email")) // flat
        assertTrue(streamEffectiveChannelLocked(m, "k", "kinfolk", "sms"))   // stream
        assertFalse(streamEffectiveChannelLocked(m, "k", "business", "sms"))
    }

    @Test
    fun lockReasonIsFlatAndBlankMeansNone() {
        assertEquals(
            "Money talk stays on",
            lockReasonFor(matrixWith("k", NotificationOverride(lockReason = "Money talk stays on")), "k"),
        )
        assertNull(lockReasonFor(matrixWith("k", NotificationOverride(lockReason = "")), "k"))
        assertNull(lockReasonFor(matrixWith("k", NotificationOverride(lockReason = "   ")), "k"))
    }

    @Test
    fun withStreamGateTouchesOnlyThatStream() {
        val base = NotificationOverride(
            enabled = false,
            lockReason = "Keep",
            streams = mapOf("kinfolk" to StreamGate(enabled = true)),
        )
        val next = base.withStreamGate("business") { it.copy(channels = it.channels + ("sms" to true)) }
        assertEquals(true, next.streams["business"]?.channels?.get("sms"))
        assertEquals(true, next.streams["kinfolk"]?.enabled) // other stream untouched
        assertEquals(false, next.enabled)                    // flat untouched
        assertEquals("Keep", next.lockReason)                // reason untouched
    }

    private val entryBK = NotificationCatalogEntry(
        key = "k",
        audiences = setOf("business", "kinfolk"),
        allowedChannels = listOf("email", "sms", "push"),
    )

    @Test
    fun togglingAChannelLockOnWritesTheStreamOnly() {
        val m = matrixWith("k", null)
        val next = toggledStreamChannelLock(m, entryBK, "kinfolk", "email")
        assertEquals(true, next.streams["kinfolk"]?.locked?.get("email"))
        assertTrue(next.locked.isEmpty()) // flat untouched
        val m2 = m.copy(overrides = mapOf("k" to next))
        assertTrue(streamEffectiveChannelLocked(m2, "k", "kinfolk", "email"))
        assertFalse(streamEffectiveChannelLocked(m2, "k", "business", "email"))
    }

    @Test
    fun togglingAStreamLockOffRemovesTheStreamEntry() {
        val m = matrixWith(
            "k",
            NotificationOverride(streams = mapOf("kinfolk" to StreamGate(locked = mapOf("email" to true)))),
        )
        val next = toggledStreamChannelLock(m, entryBK, "kinfolk", "email")
        val m2 = m.copy(overrides = mapOf("k" to next))
        assertFalse(streamEffectiveChannelLocked(m2, "k", "kinfolk", "email"))
    }

    @Test
    fun unlockingAFlatLockMaterializesItOntoTheOtherStreams() {
        // Legacy flat lock on email; the wire cannot carry locked=false, so unlocking
        // under Kinfolk must clear the flat lock and pin an explicit lock on the OTHER
        // stream so its effective state never changes.
        val m = matrixWith("k", NotificationOverride(locked = mapOf("email" to true)))
        val next = toggledStreamChannelLock(m, entryBK, "kinfolk", "email")
        assertNull(next.locked["email"])                                     // flat cleared
        assertEquals(true, next.streams["business"]?.locked?.get("email"))   // materialized
        val m2 = m.copy(overrides = mapOf("k" to next))
        assertFalse(streamEffectiveChannelLocked(m2, "k", "kinfolk", "email"))
        assertTrue(streamEffectiveChannelLocked(m2, "k", "business", "email"))
    }

    @Test
    fun togglingTheEnabledLockIsPerStream() {
        val m = matrixWith("k", null)
        val locked = toggledStreamEnabledLock(m, entryBK, "business")
        assertEquals(true, locked.streams["business"]?.lockedEnabled)

        val mFlat = matrixWith("k", NotificationOverride(lockedEnabled = true))
        val unlocked = toggledStreamEnabledLock(mFlat, entryBK, "kinfolk")
        assertEquals(false, unlocked.streams["kinfolk"]?.lockedEnabled) // explicit stream false
        assertTrue(unlocked.lockedEnabled)                              // flat still locks the rest
        val m2 = mFlat.copy(overrides = mapOf("k" to unlocked))
        assertFalse(streamEffectiveLockedEnabled(m2, "k", "kinfolk"))
        assertTrue(streamEffectiveLockedEnabled(m2, "k", "business"))
    }
}
