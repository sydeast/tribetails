package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Account screen's one-switch-per-channel reading of the admin's own
 * prefs, mirroring `myNotificationsEdit.test.ts` on web: the switch reports
 * ON when at least one editable row reaches the operator on that channel,
 * counts only what the operator may decide, and a flip touches exactly that
 * channel on exactly those rows.
 */
class AccountChannelSwitchTest {

    private val invoice = NotificationCatalogEntry(
        key = "invoice.new", category = "invoice", audience = "business",
        allowedChannels = listOf("email", "sms", "push"),
        required = mapOf("email" to true), // email forced by the catalog
    )
    private val ops = NotificationCatalogEntry(
        key = "ops.alert", category = "ops", audience = "business",
        allowedChannels = listOf("email", "push"),
    )
    private val visitNote = NotificationCatalogEntry(
        key = "visit.note", category = "visits",
        allowedChannels = listOf("email", "sms", "push"),
        audiences = setOf(STREAM_STAFF),
    )
    private val kintale = NotificationCatalogEntry(
        key = "kintale.new", category = "kintale", audience = "kinfolk",
        allowedChannels = listOf("email", "sms", "push"),
    )

    private val matrix = NotificationMatrix(
        catalog = listOf(invoice, ops, visitNote, kintale),
        overrides = mapOf(
            // ops: push switched off by the gate, so push is not offered there.
            "ops.alert" to NotificationOverride(enabled = true, channels = mapOf("push" to false)),
            // visit.note: sms locked on by the operator; not the recipient's to decide.
            "visit.note" to NotificationOverride(enabled = true, locked = mapOf("sms" to true)),
        ),
    )
    private val scopes = matrix.accountChannelScopes()
    private val empty = AdminNotificationPrefs()

    @Test
    fun scopesAreTheTwoHatsTheOperatorWears() {
        assertEquals(listOf(STREAM_BUSINESS, STREAM_STAFF), scopes.map { it.stream })
        assertEquals(listOf("invoice.new", "ops.alert"), scopes[0].entries.map { it.key })
        assertEquals(listOf("visit.note"), scopes[1].entries.map { it.key })
        // The kinfolk copy is not the operator's to receive.
        assertNull(scopes.flatMap { it.entries }.find { it.key == "kintale.new" })
    }

    @Test
    fun countIsOnlyWhatTheOperatorMayDecide() {
        // email: invoice is forced (catalog-required), ops and visit.note are free.
        assertEquals(2, matrix.channelMasterCount(scopes, "email"))
        // sms: invoice offers it; visit.note's sms is locked by the business.
        assertEquals(1, matrix.channelMasterCount(scopes, "sms"))
        // push: invoice and visit.note offer it; ops' push is gated off.
        assertEquals(2, matrix.channelMasterCount(scopes, "push"))
    }

    @Test
    fun switchReadsOnWhenAnyEditableRowReachesTheOperator() {
        // The catalog default: email on, sms and push off.
        assertTrue(empty.channelMasterOn(matrix, scopes, "email"))
        assertFalse(empty.channelMasterOn(matrix, scopes, "sms"))
        assertFalse(empty.channelMasterOn(matrix, scopes, "push"))
        // One row opted in is enough to read ON.
        val one = empty.withByKeyChannel("invoice.new", "push", true)
        assertTrue(one.channelMasterOn(matrix, scopes, "push"))
    }

    @Test
    fun forcedChannelsNeverPinTheSwitch() {
        // Only the forced invoice email is on: every editable email row is off.
        val prefs = AdminNotificationPrefs(
            byKey = mapOf("ops.alert" to mapOf("email" to false), "visit.note" to mapOf("email" to false)),
        )
        assertFalse(prefs.channelMasterOn(matrix, scopes, "email"))
    }

    @Test
    fun flipWritesExactlyThatChannelOnExactlyTheEditableRows() {
        val next = empty.applyChannelToggle(matrix, scopes, "sms", on = true)
        assertEquals(mapOf("invoice.new" to mapOf("sms" to true)), next.byKey)
        assertTrue(next.channelMasterOn(matrix, scopes, "sms"))
        // The other channels' choices are untouched.
        assertEquals(empty.byCategory, next.byCategory)
        assertEquals(empty.marketingOptIn, next.marketingOptIn)
    }

    @Test
    fun flipOffSilencesTheChannelWithoutTouchingItsNeighbours() {
        val before = empty
            .withByKeyChannel("ops.alert", "push", true)
            .withByKeyChannel("visit.note", "push", true)
        val next = before.applyChannelToggle(matrix, scopes, "email", on = false)
        assertFalse(next.channelMasterOn(matrix, scopes, "email"))
        assertEquals(
            mapOf(
                "ops.alert" to mapOf("push" to true, "email" to false),
                "visit.note" to mapOf("push" to true, "email" to false),
            ),
            next.byKey,
        )
        // Push stayed exactly where the operator left it.
        assertTrue(next.channelMasterOn(matrix, scopes, "push"))
    }

    @Test
    fun noEditableRowMeansAZeroCountAndAnOffSwitchAndANoOpFlip() {
        val silent = NotificationMatrix(catalog = listOf(kintale))
        val s = silent.accountChannelScopes()
        assertEquals(0, silent.channelMasterCount(s, "email"))
        assertFalse(empty.channelMasterOn(silent, s, "email"))
        assertEquals(empty, empty.applyChannelToggle(silent, s, "email", on = true))
    }
}
