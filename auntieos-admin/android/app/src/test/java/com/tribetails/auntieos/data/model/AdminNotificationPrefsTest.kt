package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic contract for the admin's OWN notification receive-prefs after the
 * revamp: the screen stacks two sections, "As the owner" (business stream) and
 * "As the Auntie" (staff stream). Visibility, offered channels, forced channels and
 * the forced reason are all STREAM-aware, and the reason prefers the operator's
 * lockReason over the built-in fallback strings.
 */
class AdminNotificationPrefsTest {

    private val invoice = NotificationCatalogEntry(
        key = "invoice.new", category = "invoice", audience = "both",
        allowedChannels = listOf("email", "sms", "push"),
        required = mapOf("email" to true),
    ) // legacy "both" -> audiences {kinfolk, business}
    private val visitNote = NotificationCatalogEntry(
        key = "visit.note", category = "visits",
        allowedChannels = listOf("email", "push"),
        audiences = setOf(STREAM_STAFF, STREAM_KINFOLK),
    )
    private val ops = NotificationCatalogEntry(
        key = "ops.alert", category = "ops", audience = "business",
        allowedChannels = listOf("email", "push"),
    )
    private val kintale = NotificationCatalogEntry(
        key = "kintale.new", category = "kintale", audience = "kinfolk",
        allowedChannels = listOf("email", "sms", "push"),
    )

    private val matrix = NotificationMatrix(
        catalog = listOf(invoice, visitNote, ops, kintale),
        overrides = mapOf(
            // ops: push disabled by the flat gate; email still on (catalog default).
            "ops.alert" to NotificationOverride(enabled = true, channels = mapOf("push" to false)),
            // invoice: sms locked on by the operator, with an operator-written reason.
            "invoice.new" to NotificationOverride(
                enabled = true,
                locked = mapOf("sms" to true),
                lockReason = "Money news can't wait.",
            ),
            // visit.note: the STAFF stream is switched off; kinfolk copy stays live.
            "visit.note" to NotificationOverride(
                streams = mapOf(STREAM_STAFF to StreamGate(enabled = false)),
            ),
        ),
    )

    // ── section visibility ───────────────────────────────────────────────────

    @Test
    fun ownerSectionShowsBusinessStreamEntries() {
        assertTrue(invoice.adminReceives(matrix, STREAM_BUSINESS))
        assertTrue(ops.adminReceives(matrix, STREAM_BUSINESS))
        assertFalse(kintale.adminReceives(matrix, STREAM_BUSINESS))   // kinfolk-only
        assertFalse(visitNote.adminReceives(matrix, STREAM_BUSINESS)) // staff+kinfolk key
    }

    @Test
    fun auntieSectionShowsStaffStreamAndHonoursStreamGate() {
        // Staff stream disabled by the override -> hidden from the "As the Auntie" section.
        assertFalse(visitNote.adminReceives(matrix, STREAM_STAFF))
        // With the gate open it appears.
        val open = matrix.copy(overrides = matrix.overrides - "visit.note")
        assertTrue(visitNote.adminReceives(open, STREAM_STAFF))
        assertFalse(invoice.adminReceives(open, STREAM_STAFF)) // business+kinfolk key never in Auntie section
    }

    @Test
    fun staffSectionHiddenWhenNoStreamEnabledChannelRemains() {
        val choked = NotificationMatrix(
            catalog = listOf(visitNote),
            overrides = mapOf(
                "visit.note" to NotificationOverride(
                    streams = mapOf(
                        STREAM_STAFF to StreamGate(channels = mapOf("email" to false, "push" to false)),
                    ),
                ),
            ),
        )
        assertFalse(visitNote.adminReceives(choked, STREAM_STAFF))   // zero channels left
        assertTrue(visitNote.adminReceives(choked, STREAM_KINFOLK))  // other stream unaffected
    }

    @Test
    fun sharedBusinessKinfolkKeyAppearsOnceInOwnerSection() {
        // The prefs screen has no kinfolk section, so a {business, kinfolk} key shows
        // exactly once: under "As the owner".
        assertTrue(invoice.adminReceives(matrix, STREAM_BUSINESS))
        assertFalse(invoice.adminReceives(matrix, STREAM_STAFF))
    }

    // ── offered + forced channels, stream-aware ──────────────────────────────

    @Test
    fun channelOfferedReflectsStreamGate() {
        assertTrue(matrix.channelOfferedToUser(ops, "email", STREAM_BUSINESS))
        assertFalse(matrix.channelOfferedToUser(ops, "push", STREAM_BUSINESS)) // flat gate off, inherited
        assertFalse(matrix.channelOfferedToUser(ops, "sms", STREAM_BUSINESS))  // not in allowedChannels
        // Per-stream shut-off: staff loses push, the kinfolk copy keeps it.
        val m2 = NotificationMatrix(
            catalog = listOf(visitNote),
            overrides = mapOf(
                "visit.note" to NotificationOverride(
                    streams = mapOf(STREAM_STAFF to StreamGate(channels = mapOf("push" to false))),
                ),
            ),
        )
        assertFalse(m2.channelOfferedToUser(visitNote, "push", STREAM_STAFF))
        assertTrue(m2.channelOfferedToUser(visitNote, "push", STREAM_KINFOLK))
    }

    @Test
    fun forcedChannelsAreStreamAware() {
        assertTrue(matrix.channelForcedForUser(invoice, "email", STREAM_BUSINESS)) // catalog-required everywhere
        assertTrue(matrix.channelForcedForUser(invoice, "sms", STREAM_BUSINESS))   // flat lock inherited
        assertFalse(matrix.channelForcedForUser(invoice, "push", STREAM_BUSINESS))
        val m2 = NotificationMatrix(
            catalog = listOf(visitNote),
            overrides = mapOf(
                "visit.note" to NotificationOverride(
                    streams = mapOf(STREAM_STAFF to StreamGate(locked = mapOf("push" to true))),
                ),
            ),
        )
        assertTrue(m2.channelForcedForUser(visitNote, "push", STREAM_STAFF))
        assertFalse(m2.channelForcedForUser(visitNote, "push", STREAM_KINFOLK))
    }

    // ── forced reason: operator lockReason first, then fallbacks ─────────────

    @Test
    fun forcedReasonPrefersOperatorLockReason() {
        assertEquals("Money news can't wait.", matrix.channelForcedReason(invoice, "sms", STREAM_BUSINESS))
        // The operator's reason wins over the catalog-required fallback too.
        assertEquals("Money news can't wait.", matrix.channelForcedReason(invoice, "email", STREAM_BUSINESS))
        assertEquals("", matrix.channelForcedReason(invoice, "push", STREAM_BUSINESS)) // not forced
    }

    @Test
    fun forcedReasonFallsBackToBuiltInStrings() {
        val plain = NotificationMatrix(
            catalog = listOf(invoice),
            overrides = mapOf("invoice.new" to NotificationOverride(locked = mapOf("sms" to true))),
        )
        assertEquals(
            "Set by the notification itself; your choice here can't turn it off.",
            plain.channelForcedReason(invoice, "email", STREAM_BUSINESS),
        )
        assertEquals(
            "Set in your business settings; your choice here can't turn it off.",
            plain.channelForcedReason(invoice, "sms", STREAM_BUSINESS),
        )
    }
    /**
     * #451. The fallbacks used to read "Required for this notification." and
     * "Locked on by your business settings." Both implied a guarantee this
     * layer does not have: the business gate can switch even a catalog-required
     * channel off, and `resolveChannels` honors that (ruling #7, 2026-06-08,
     * warn-but-allow-off). The words may name WHO decides; they may not promise
     * the channel keeps sending. This is the test that stops "Always on" and a
     * bare "Required" coming back.
     */
    @Test
    fun forcedReasonNeverPromisesAlwaysOnOrBareRequired() {
        val plain = NotificationMatrix(
            catalog = listOf(invoice),
            overrides = mapOf("invoice.new" to NotificationOverride(locked = mapOf("sms" to true))),
        )
        listOf("email", "sms").forEach { channel ->
            val line = plain.channelForcedReason(invoice, channel, STREAM_BUSINESS)
            assertFalse("reason for $channel says always: $line", line.contains("always", ignoreCase = true))
            assertFalse("reason for $channel says required: $line", line.contains("required", ignoreCase = true))
            assertTrue("reason for $channel does not name who decides: $line", line.startsWith("Set "))
        }
    }
    /**
     * #451 vocabulary check on the constant the prefs screen's channel pill
     * renders: it names who decides and never claims permanence.
     */
    @Test
    fun channelPillNamesWhoDecidesRatherThanPromisingAlwaysOn() {
        assertEquals("Set by your business", NOTIF_CHANNEL_SET_BY_BUSINESS)
    }

    // ── the admin's own prefs precedence (unchanged by the revamp) ───────────

    @Test
    fun effectiveReceiveDefaultsEmailOnSmsPushOff() {
        val empty = AdminNotificationPrefs()
        assertTrue(empty.effectiveReceive(invoice, "email"))
        assertFalse(empty.effectiveReceive(invoice, "sms"))
        assertFalse(empty.effectiveReceive(invoice, "push"))
    }

    @Test
    fun effectiveReceiveByKeyWinsOverCategory() {
        val prefs = AdminNotificationPrefs(
            byCategory = mapOf("invoice" to mapOf("push" to true)),
            byKey = mapOf("invoice.new" to mapOf("push" to false)),
        )
        assertFalse(prefs.effectiveReceive(invoice, "push")) // byKey wins over byCategory

        val catOnly = AdminNotificationPrefs(byCategory = mapOf("invoice" to mapOf("sms" to true)))
        assertTrue(catOnly.effectiveReceive(invoice, "sms")) // category fallback applies
    }

    @Test
    fun withByKeyChannelSetsAndPreserves() {
        val p = AdminNotificationPrefs()
            .withByKeyChannel("invoice.new", "push", true)
            .withByKeyChannel("invoice.new", "sms", true)
        assertEquals(mapOf("push" to true, "sms" to true), p.byKey["invoice.new"])
    }

    // ── applyBulkToggle: the #390 Android parity fix ─────────────────────────

    @Test
    fun applyBulkToggleOnFlipsOnlyOfferedAndUnforcedChannels() {
        val next = AdminNotificationPrefs().applyBulkToggle(matrix, listOf(invoice, ops), STREAM_BUSINESS, true)
        // invoice: email is catalog-required, sms is operator-locked; only push is editable.
        assertEquals(mapOf("push" to true), next.byKey["invoice.new"])
        // ops: push is not OFFERED (flat gate turned it off); only email is editable.
        assertEquals(mapOf("email" to true), next.byKey["ops.alert"])
    }

    @Test
    fun applyBulkToggleOffDoesNotFakeAForcedChannelOff() {
        val start = AdminNotificationPrefs(byKey = mapOf("invoice.new" to mapOf("push" to true)))
        val next = start.applyBulkToggle(matrix, listOf(invoice), STREAM_BUSINESS, false)
        // push (editable) flips off; email/sms (forced) are never written, not faked off.
        assertEquals(mapOf("push" to false), next.byKey["invoice.new"])
        assertFalse(next.byKey.getValue("invoice.new").containsKey("email"))
        assertFalse(next.byKey.getValue("invoice.new").containsKey("sms"))
    }

    @Test
    fun applyBulkTogglePreservesUnrelatedKeysAndCategoryPrefs() {
        val start = AdminNotificationPrefs(
            byKey = mapOf("kintale.new" to mapOf("email" to true)),
            byCategory = mapOf("ops" to mapOf("push" to true)),
        )
        val next = start.applyBulkToggle(matrix, listOf(invoice), STREAM_BUSINESS, true)
        assertEquals(mapOf("email" to true), next.byKey["kintale.new"]) // untouched key
        assertEquals(mapOf("push" to true), next.byCategory["ops"]) // untouched, byKey-only writer
    }

    @Test
    fun applyBulkToggleChainsAcrossStreamsForThePageLevelControl() {
        // Mirrors AdminNotificationPrefsScreen.persistBulk (#390): one applyBulkToggle
        // call per hat, threaded through the accumulating prefs, so the page-level "All
        // on" ends up covering both "As the owner" and "As the Auntie" in one object.
        val staffOpen = matrix.copy(overrides = matrix.overrides - "visit.note")
        var next = AdminNotificationPrefs()
        next = next.applyBulkToggle(staffOpen, listOf(invoice, ops), STREAM_BUSINESS, true)
        next = next.applyBulkToggle(staffOpen, listOf(visitNote), STREAM_STAFF, true)
        assertEquals(mapOf("push" to true), next.byKey["invoice.new"])
        assertEquals(mapOf("email" to true), next.byKey["ops.alert"])
        assertEquals(mapOf("email" to true, "push" to true), next.byKey["visit.note"])
    }
}
