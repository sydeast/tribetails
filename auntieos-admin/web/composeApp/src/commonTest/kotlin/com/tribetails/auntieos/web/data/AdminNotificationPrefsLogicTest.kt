package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure logic for the admin's own notification settings screen, now per STREAM: which
 * notifications show under "As the owner" (business stream) and "As the Auntie" (staff
 * stream), which channels are offered, which are forced read-only, and how the reason
 * line resolves (operator lockReason first, stock strings after). Mirrors the
 * dispatcher's resolveChannels precedence (functions/src/notifications/prefs.ts).
 */
class AdminNotificationPrefsLogicTest {

    private fun entry(
        key: String,
        audiences: Set<String>,
        category: String = "",
        allowed: List<String> = listOf("email", "sms", "push"),
        required: Map<String, Boolean> = emptyMap(),
    ) = NotificationCatalogEntry(
        key = key,
        category = category,
        audiences = audiences,
        allowedChannels = allowed,
        required = required,
    )

    private val matrix = NotificationMatrix(
        catalog = listOf(
            entry("invoice.new", setOf("business", "kinfolk"), "invoice"),
            entry("security.alert", setOf("business"), "security", allowed = listOf("email", "push"), required = mapOf("email" to true)),
            entry("visit.note", setOf("staff", "kinfolk"), "visit"),
            entry("kintale.posted", setOf("kinfolk"), "kintale"),
            entry("schedule.digest", setOf("staff"), "schedule"),
            entry("payments.dunning", setOf("business"), "invoice", allowed = listOf("email", "sms")),
        ),
        overrides = mapOf(
            // invoice.new: flat SMS off; PUSH locked; the operator wrote a reason.
            "invoice.new" to NotificationOverride(
                channels = mapOf("sms" to false),
                locked = mapOf("push" to true),
                lockReason = "Money talk stays on so nobody misses a bill",
            ),
            // schedule.digest: gated off for the STAFF stream only.
            "schedule.digest" to NotificationOverride(streams = mapOf("staff" to StreamGate(enabled = false))),
            // visit.note: the KINFOLK copy is off; the staff copy must be unaffected.
            "visit.note" to NotificationOverride(streams = mapOf("kinfolk" to StreamGate(enabled = false))),
            // payments.dunning: whole notification disabled flat -> hidden everywhere.
            "payments.dunning" to NotificationOverride(enabled = false),
        ),
    )

    @Test
    fun ownerSectionShowsBusinessStreamEntries() {
        val keys = adminVisibleNotifications(matrix, "business").map { it.key }
        assertEquals(listOf("invoice.new", "security.alert"), keys)
    }

    @Test
    fun auntieSectionShowsStaffStreamEntries() {
        val keys = adminVisibleNotifications(matrix, "staff").map { it.key }
        assertEquals(listOf("visit.note"), keys) // schedule.digest is stream-gated off
    }

    @Test
    fun kinfolkOnlyKeysNeverReachTheAdminScreen() {
        assertFalse(adminVisibleNotifications(matrix, "business").any { it.key == "kintale.posted" })
        assertFalse(adminVisibleNotifications(matrix, "staff").any { it.key == "kintale.posted" })
    }

    @Test
    fun aBusinessPlusKinfolkKeyAppearsExactlyOnceAcrossSections() {
        val owner = adminVisibleNotifications(matrix, "business").map { it.key }
        val staff = adminVisibleNotifications(matrix, "staff").map { it.key }
        assertEquals(1, (owner + staff).count { it == "invoice.new" })
    }

    @Test
    fun aStreamDisableHidesOnlyThatStream() {
        // visit.note is off for kinfolk but still visible to staff.
        assertTrue(adminVisibleNotifications(matrix, "staff").any { it.key == "visit.note" })
        assertFalse(adminVisibleNotifications(matrix, "kinfolk").any { it.key == "visit.note" })
    }

    @Test
    fun gateChannelsAreStreamAware() {
        val invoice = matrix.catalog.first { it.key == "invoice.new" }
        assertEquals(listOf("email", "push"), adminGateEnabledChannels(matrix, invoice, "business")) // flat sms off
        // A stream can re-open a flat-disabled channel for its own audience.
        val reopened = matrix.overrides.getValue("invoice.new")
            .withStreamGate("business") { it.copy(channels = it.channels + ("sms" to true)) }
        val m2 = matrix.copy(overrides = matrix.overrides + ("invoice.new" to reopened))
        assertEquals(listOf("email", "sms", "push"), adminGateEnabledChannels(m2, invoice, "business"))
        assertEquals(listOf("email", "push"), adminGateEnabledChannels(m2, invoice, "kinfolk")) // kinfolk still flat
    }

    @Test
    fun channelForcedIsStreamAware() {
        val invoice = matrix.catalog.first { it.key == "invoice.new" }
        val security = matrix.catalog.first { it.key == "security.alert" }
        assertTrue(adminChannelForced(matrix, security, "business", "email")) // catalog-required
        assertTrue(adminChannelForced(matrix, invoice, "business", "push"))   // flat lock reaches every stream
        assertFalse(adminChannelForced(matrix, invoice, "business", "email"))
        // A stream-only lock forces just that stream.
        val visit = matrix.catalog.first { it.key == "visit.note" }
        val lockedStaff = matrix.overrides.getValue("visit.note")
            .withStreamGate("staff") { it.copy(locked = it.locked + ("push" to true)) }
        val m2 = matrix.copy(overrides = matrix.overrides + ("visit.note" to lockedStaff))
        assertTrue(adminChannelForced(m2, visit, "staff", "push"))
        assertFalse(adminChannelForced(m2, visit, "kinfolk", "push"))
    }

    @Test
    fun lockedEnabledForcesEveryChannelInThatStream() {
        val visit = matrix.catalog.first { it.key == "visit.note" }
        val lockedStaff = matrix.overrides.getValue("visit.note")
            .withStreamGate("staff") { it.copy(lockedEnabled = true) }
        val m2 = matrix.copy(overrides = matrix.overrides + ("visit.note" to lockedStaff))
        assertTrue(adminChannelForced(m2, visit, "staff", "email"))
        assertFalse(adminChannelForced(m2, visit, "kinfolk", "email"))
    }

    @Test
    fun reasonPrefersTheOperatorsLockReason() {
        val invoice = matrix.catalog.first { it.key == "invoice.new" }
        assertEquals("Money talk stays on so nobody misses a bill", adminChannelReason(matrix, invoice, "push"))
    }

    @Test
    fun reasonFallsBackToStockStringsWithoutALockReason() {
        val security = matrix.catalog.first { it.key == "security.alert" }
        assertEquals("Always on for this notification.", adminChannelReason(matrix, security, "email"))
        // Business-locked without an operator reason -> stock line.
        val cleared = matrix.overrides.getValue("invoice.new").copy(lockReason = null)
        val noReason = matrix.copy(overrides = matrix.overrides + ("invoice.new" to cleared))
        val invoice = matrix.catalog.first { it.key == "invoice.new" }
        assertEquals("Locked on by your business settings.", adminChannelReason(noReason, invoice, "push"))
    }

    @Test
    fun userChannelChoiceFollowsByKeyThenByCategoryThenDefault() {
        val prefs = AdminNotificationPrefs(
            byKey = mapOf("invoice.new" to ChannelPrefs(email = false)),
            byCategory = mapOf("invoice" to ChannelPrefs(sms = true)),
        )
        // byKey wins.
        assertFalse(prefs.userChannelChoice("invoice.new", "invoice", "email"))
        // falls through to byCategory.
        assertTrue(prefs.userChannelChoice("invoice.new", "invoice", "sms"))
        // no pref at all -> catalog default (email on, push off).
        assertTrue(prefs.userChannelChoice("other.key", "invoice", "email"))
        assertFalse(prefs.userChannelChoice("other.key", "invoice", "push"))
    }
}
