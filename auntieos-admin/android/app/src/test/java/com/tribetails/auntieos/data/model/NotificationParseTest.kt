package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wire-contract tests for the notification gate parse/serialize pure functions
 * (notification-settings revamp). Mirrors the frozen MyTribe contract:
 *  - catalog entries carry `audiences: { business|staff|kinfolk: true }` (subset, >=1);
 *    absent -> legacy fallback from the flat `audience` string.
 *  - overrides carry optional flat `lockReason` and per-stream `streams` gates.
 *  - saveBusinessNotificationOverride payload: locks only-true, empty stream gates
 *    omitted, lockReason omitted when null and sent as "" only to clear (max 300).
 */
class NotificationParseTest {

    // ── catalog: audiences decode ────────────────────────────────────────────

    @Test
    fun catalogParsesAudiencesObjectKeys() {
        val entry = notificationCatalogEntryFromMap(
            mapOf(
                "key" to "visit.note",
                "category" to "visits",
                "audience" to "kinfolk",
                "allowedChannels" to listOf("email", "push"),
                "audiences" to mapOf("kinfolk" to true, "staff" to true),
            ),
        )!!
        assertEquals(setOf(STREAM_KINFOLK, STREAM_STAFF), entry.audiences)
    }

    @Test
    fun catalogAudiencesIgnoresNonTrueValues() {
        assertEquals(
            setOf(STREAM_KINFOLK),
            audienceSetFromRaw(mapOf("kinfolk" to true, "business" to false), legacyAudience = ""),
        )
    }

    @Test
    fun catalogMissingAudiencesFallsBackToLegacyAudience() {
        assertEquals(setOf(STREAM_BUSINESS), audienceSetFromRaw(null, "business"))
        assertEquals(setOf(STREAM_KINFOLK), audienceSetFromRaw(null, "kinfolk"))
        assertEquals(setOf(STREAM_KINFOLK, STREAM_BUSINESS), audienceSetFromRaw(null, "both"))
        // Unknown/blank falls back to kinfolk so nothing is ever dropped from the UI.
        assertEquals(setOf(STREAM_KINFOLK), audienceSetFromRaw(null, ""))
        // Empty object (contract says >=1, but stay liberal) also falls back.
        assertEquals(setOf(STREAM_BUSINESS), audienceSetFromRaw(emptyMap<String, Any>(), "business"))
    }

    @Test
    fun catalogEntryConstructorDefaultsAudiencesFromLegacyAudience() {
        assertEquals(
            setOf(STREAM_KINFOLK, STREAM_BUSINESS),
            NotificationCatalogEntry(key = "k", audience = "both").audiences,
        )
        assertEquals(setOf(STREAM_BUSINESS), NotificationCatalogEntry(key = "k", audience = "business").audiences)
    }

    @Test
    fun catalogParseRejectsMissingKeyAndKeepsFlatFields() {
        assertNull(notificationCatalogEntryFromMap(mapOf("category" to "visits")))
        val entry = notificationCatalogEntryFromMap(
            mapOf(
                "key" to "booking.confirmed",
                "category" to "Bookings",
                "audience" to "both",
                "allowedChannels" to listOf("email", "sms"),
                "required" to mapOf("email" to true),
                "alwaysEnabled" to true,
                "kinfolkFacing" to true,
                "deliveryMode" to "instant",
                "description" to "Booking confirmed",
                "marketingCategory" to "promos",
            ),
        )!!
        assertEquals("Bookings", entry.category)
        assertEquals(listOf("email", "sms"), entry.allowedChannels)
        assertEquals(mapOf("email" to true), entry.required)
        assertTrue(entry.alwaysEnabled)
        assertTrue(entry.kinfolkFacing)
        assertEquals("instant", entry.deliveryMode)
        assertEquals("Booking confirmed", entry.description)
        assertEquals("promos", entry.marketingCategory)
        assertEquals(setOf(STREAM_KINFOLK, STREAM_BUSINESS), entry.audiences)
    }

    // ── catalog: label + alwaysEnabledStreams decode ─────────────────────────

    @Test
    fun catalogParsesLabelAndDefaultsBlank() {
        val withLabel = notificationCatalogEntryFromMap(
            mapOf("key" to "kincare.note.auntie", "label" to "New visit note"),
        )!!
        assertEquals("New visit note", withLabel.label)
        val without = notificationCatalogEntryFromMap(mapOf("key" to "k"))!!
        assertEquals("", without.label)
    }

    @Test
    fun catalogParsesAlwaysEnabledStreamsTrueKeysOnly() {
        val entry = notificationCatalogEntryFromMap(
            mapOf(
                "key" to "kincare.booking.confirm",
                "alwaysEnabled" to true,
                "alwaysEnabledStreams" to mapOf("kinfolk" to true, "business" to false),
            ),
        )!!
        assertEquals(setOf(STREAM_KINFOLK), entry.alwaysEnabledStreams)
    }

    @Test
    fun catalogMissingAlwaysEnabledStreamsDecodesEmpty() {
        val entry = notificationCatalogEntryFromMap(mapOf("key" to "k", "alwaysEnabled" to true))!!
        assertTrue(entry.alwaysEnabledStreams.isEmpty())
    }

    // ── override: parse streams + lockReason ────────────────────────────────

    @Test
    fun overrideParsesStreamsAndLockReason() {
        val o = notificationOverrideFromMap(
            mapOf(
                "enabled" to false,
                "channels" to mapOf("sms" to false),
                "lockedEnabled" to true,
                "locked" to mapOf("email" to true),
                "lockReason" to "Money news can't wait.",
                "streams" to mapOf(
                    "kinfolk" to mapOf(
                        "enabled" to true,
                        "channels" to mapOf("push" to false),
                        "lockedEnabled" to true,
                        "locked" to mapOf("email" to true),
                    ),
                    "staff" to mapOf("enabled" to false),
                ),
            ),
        )
        assertFalse(o.enabled)
        assertEquals(mapOf("sms" to false), o.channels)
        assertTrue(o.lockedEnabled)
        assertEquals(mapOf("email" to true), o.locked)
        assertEquals("Money news can't wait.", o.lockReason)
        assertEquals(
            StreamGate(
                enabled = true,
                channels = mapOf("push" to false),
                lockedEnabled = true,
                locked = mapOf("email" to true),
            ),
            o.streams["kinfolk"],
        )
        assertEquals(StreamGate(enabled = false), o.streams["staff"])
    }

    @Test
    fun overrideParseBlankLockReasonIsNull() {
        assertNull(notificationOverrideFromMap(mapOf("enabled" to true, "lockReason" to "  ")).lockReason)
        assertNull(notificationOverrideFromMap(mapOf("enabled" to true)).lockReason)
    }

    @Test
    fun overrideParseDefaultsWhenFieldsAbsent() {
        val o = notificationOverrideFromMap(emptyMap<String, Any>())
        assertTrue(o.enabled)
        assertTrue(o.channels.isEmpty())
        assertFalse(o.lockedEnabled)
        assertTrue(o.locked.isEmpty())
        assertNull(o.lockReason)
        assertTrue(o.streams.isEmpty())
    }

    // ── override: serialize payload ─────────────────────────────────────────

    @Test
    fun payloadOmitsEmptyStreamGatesAndOffLocks() {
        val p = NotificationOverride(
            enabled = true,
            channels = mapOf("sms" to false),
            lockedEnabled = false,
            locked = mapOf("email" to false), // off-lock: never sent (backend accepts only true)
            streams = mapOf(
                "kinfolk" to StreamGate(),                                     // empty -> omitted
                "staff" to StreamGate(lockedEnabled = false),                  // serializes empty -> omitted
                "business" to StreamGate(enabled = false, locked = mapOf("push" to false)),
            ),
        ).toCallablePayload()
        assertEquals(true, p["enabled"])
        assertEquals(mapOf("sms" to false), p["channels"])
        assertFalse(p.containsKey("lockedEnabled"))
        assertFalse(p.containsKey("locked"))
        assertFalse(p.containsKey("lockReason"))
        val streams = p["streams"] as Map<*, *>
        assertFalse(streams.containsKey("kinfolk"))
        assertFalse(streams.containsKey("staff"))
        assertEquals(mapOf("enabled" to false), streams["business"])
    }

    @Test
    fun payloadStreamsFieldOmittedWhenNothingToSend() {
        val p = NotificationOverride(streams = mapOf("kinfolk" to StreamGate())).toCallablePayload()
        assertFalse(p.containsKey("streams"))
    }

    @Test
    fun payloadSendsOnlyTrueLocksInStreams() {
        val p = NotificationOverride(
            lockedEnabled = true,
            locked = mapOf("email" to true, "sms" to false),
            streams = mapOf(
                "kinfolk" to StreamGate(
                    channels = mapOf("sms" to true),
                    lockedEnabled = true,
                    locked = mapOf("push" to true, "email" to false),
                ),
            ),
        ).toCallablePayload()
        assertEquals(true, p["lockedEnabled"])
        assertEquals(mapOf("email" to true), p["locked"])
        val kin = (p["streams"] as Map<*, *>)["kinfolk"] as Map<*, *>
        assertEquals(true, kin["lockedEnabled"])
        assertEquals(mapOf("push" to true), kin["locked"])
        assertEquals(mapOf("sms" to true), kin["channels"])
    }

    @Test
    fun payloadLockReasonNullOmittedEmptyClearsTextSent() {
        assertFalse(NotificationOverride(lockReason = null).toCallablePayload().containsKey("lockReason"))
        assertEquals("", NotificationOverride(lockReason = "").toCallablePayload()["lockReason"])
        assertEquals(
            "Auntie keeps this one on.",
            NotificationOverride(lockReason = "Auntie keeps this one on.").toCallablePayload()["lockReason"],
        )
    }

    @Test
    fun payloadLockReasonClampedTo300() {
        val long = "x".repeat(400)
        assertEquals(300, (NotificationOverride(lockReason = long).toCallablePayload()["lockReason"] as String).length)
    }

    @Test
    fun payloadRoundtripsThroughParse() {
        val o = NotificationOverride(
            enabled = false,
            channels = mapOf("email" to true, "sms" to false),
            lockedEnabled = true,
            locked = mapOf("email" to true),
            lockReason = "Auntie needs these.",
            streams = mapOf(
                "kinfolk" to StreamGate(
                    enabled = true,
                    channels = mapOf("push" to false),
                    lockedEnabled = true,
                    locked = mapOf("email" to true),
                ),
            ),
        )
        assertEquals(o, notificationOverrideFromMap(o.toCallablePayload()))
    }

    // ── #396: provenance + delivery wire fields ─────────────────────────────
    /**
     * Every provenance field is additive and optional, because the backend and
     * this app deploy separately. An older payload must still parse into a row
     * that simply has nothing to show, never into a crash or a half-row.
     */
    @Test
    fun catalogParsesProvenanceFields() {
        val entry = notificationCatalogEntryFromMap(
            mapOf(
                "key" to "invoice.new",
                "audience" to "both",
                "whoReceives" to listOf("The household's own portal account.", "Every business admin."),
                "recipientResolver" to "kinfolkAcct",
                "secondaryResolver" to "businessAdmins",
                "emitters" to listOf(
                    mapOf(
                        "trigger" to "An admin creates an invoice.",
                        "source" to "src/admin/createInvoice.ts",
                        "dataKeys" to listOf("kinfolkId", "invoiceId"),
                    ),
                ),
                "neverFires" to false,
                "templates" to mapOf("email" to "invoice.new.v2"),
                "emailTemplateRetargetedFrom" to "invoice.new",
                "mergeFields" to listOf("amount"),
                "external" to false,
            ),
        )!!
        assertEquals(2, entry.whoReceives.size)
        assertEquals("businessAdmins", entry.secondaryResolver)
        assertEquals(1, entry.emitters.size)
        assertEquals("src/admin/createInvoice.ts", entry.emitters[0].source)
        assertEquals(listOf("kinfolkId", "invoiceId"), entry.emitters[0].dataKeys)
        assertEquals("invoice.new.v2", entry.templates["email"])
        assertEquals("invoice.new", entry.emailTemplateRetargetedFrom)
        assertEquals(listOf("amount"), entry.mergeFields)
    }
    @Test
    fun catalogWithoutProvenanceStillParsesEmpty() {
        val entry = notificationCatalogEntryFromMap(mapOf("key" to "k", "audience" to "kinfolk"))!!
        assertEquals(emptyList<String>(), entry.whoReceives)
        assertEquals(emptyList<NotificationEmitter>(), entry.emitters)
        assertNull(entry.secondaryResolver)
        assertFalse(entry.neverFires)
        assertFalse(entry.external)
    }
    @Test
    fun emitterWithNoTriggerIsDroppedRatherThanShownBlank() {
        val parsed = notificationEmittersFromRaw(
            listOf(mapOf("source" to "src/a.ts"), mapOf("trigger" to "Real one.")),
        )
        assertEquals(listOf("Real one."), parsed.map { it.trigger })
    }
    @Test
    fun ungatedSendsParseAndDropRowsWithNoTemplateId() {
        val parsed = ungatedSendsFromRaw(
            listOf(
                mapOf("templateId" to "invite.primary", "trigger" to "t", "source" to "src/a.ts"),
                mapOf("trigger" to "no id"),
            ),
        )
        assertEquals(listOf("invite.primary"), parsed.map { it.templateId })
    }
    /**
     * A channel record with no status had no sender run. Defaulting it to
     * "sent" would be the screen inventing a delivery, which is exactly what
     * #396 says not to do.
     */
    @Test
    fun deliveryAttemptWithNoStatusParsesAsUnknownNotSent() {
        val attempt = notificationDeliveryAttemptFromMap(mapOf("channel" to "email"))
        assertEquals("unknown", attempt.status)
        assertNull(attempt.providerMessageId)
        assertEquals(0, attempt.attempts)
    }
    @Test
    fun deliveryEvidenceParsesRowsAndKeepsReceiptAvailableFalseWhenAbsent() {
        val evidence = notificationDeliveryEvidenceFromMap(
            mapOf(
                "deliveries" to listOf(
                    mapOf(
                        "dispatchId" to "d1",
                        "key" to "invoice.new",
                        "recipientUid" to "kin1",
                        "status" to "dispatched",
                        "channels" to listOf("email"),
                        "createdAtMs" to 1234,
                        "attempts" to listOf(
                            mapOf(
                                "channel" to "email",
                                "status" to "sent",
                                "providerMessageId" to "smtp-1",
                                "attempts" to 1,
                            ),
                        ),
                    ),
                ),
                "sentMeaning" to "Sent means the provider accepted the message.",
            ),
        )
        assertEquals(1, evidence.deliveries.size)
        assertEquals("kin1", evidence.deliveries[0].recipientUid)
        assertEquals(1234L, evidence.deliveries[0].createdAtMs)
        assertEquals("smtp-1", evidence.deliveries[0].attempts[0].providerMessageId)
        // Absent means the backend predates the field; the safe read of an
        // unknown is "we have no receipt", never "we have one".
        assertFalse(evidence.receiptAvailable)
    }
}
