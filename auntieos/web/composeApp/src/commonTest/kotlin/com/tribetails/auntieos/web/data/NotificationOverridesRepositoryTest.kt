package com.tribetails.auntieos.web.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Phase 15.2 + streams revamp: decode + effective-state + wire-encode contract for the
 * notification matrix. Uses a fake `invoke` so the wire decode, the per-stream
 * override-vs-flat merge, and the save payload are pinned without touching a live
 * callable.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationOverridesRepositoryTest {

    private val sampleGetJson = """
        {
          "catalog": [
            { "key":"booking.confirmed", "label":"KinCare booking confirmed",
              "category":"Bookings", "audience":"kinfolk",
              "audiences": { "kinfolk": true, "business": true },
              "alwaysEnabledStreams": { "kinfolk": true },
              "allowedChannels":["email","sms","push"], "required":{"email":true},
              "alwaysEnabled":false, "kinfolkFacing":true, "deliveryMode":"transactional",
              "description":"Booking confirmed" },
            { "key":"security.breach", "category":"Security", "audience":"business",
              "allowedChannels":["email","push"], "required":{},
              "alwaysEnabled":true, "kinfolkFacing":false, "deliveryMode":"transactional",
              "description":"Breach attempt" }
          ],
          "overrides": {
            "booking.confirmed": {
              "enabled": true, "channels": { "sms": false },
              "lockReason": "Bookings stay confirmed in writing",
              "streams": {
                "kinfolk": { "channels": { "sms": true }, "locked": { "email": true } },
                "business": { "enabled": false }
              }
            }
          },
          "updatedAtMs": 1717000000000
        }
    """.trimIndent()

    private fun repo(invoke: suspend (String, String) -> WriteResult<String>) =
        CloudNotificationOverridesRepository(invoke)

    private suspend fun sampleMatrix(): NotificationMatrix =
        (repo { _, _ -> WriteResult.Ok(sampleGetJson) }.getMatrix() as WriteResult.Ok).value

    @Test
    fun decodesCatalogAndOverrides() = runTest {
        val m = sampleMatrix()
        assertEquals(2, m.catalog.size)
        assertEquals(1717000000000L, m.updatedAtMs)

        val booking = m.catalog.first { it.key == "booking.confirmed" }
        assertEquals(listOf("email", "sms", "push"), booking.allowedChannels)
        assertTrue(booking.channelLocked("email"))   // catalog-required
        assertFalse(booking.channelLocked("sms"))
        assertFalse(booking.enabledLocked())

        val security = m.catalog.first { it.key == "security.breach" }
        assertTrue(security.enabledLocked())          // alwaysEnabled
    }

    @Test
    fun decodesLabelAndAlwaysEnabledStreams() = runTest {
        val m = sampleMatrix()
        val booking = m.catalog.first { it.key == "booking.confirmed" }
        assertEquals("KinCare booking confirmed", booking.label)
        assertEquals("KinCare booking confirmed", booking.displayTitle()) // label wins over description
        assertEquals(setOf("kinfolk"), booking.alwaysEnabledStreams)     // literal-true keys only

        val security = m.catalog.first { it.key == "security.breach" }
        assertEquals("", security.label)
        assertEquals("Breach attempt", security.displayTitle())          // no label -> description
        assertEquals(emptySet<String>(), security.alwaysEnabledStreams)  // missing object -> empty set
    }

    @Test
    fun decodesAudiencesObjectWinningOverLegacyField() = runTest {
        val m = sampleMatrix()
        // booking.confirmed: legacy audience says "kinfolk" but the audiences object wins.
        assertEquals(setOf("kinfolk", "business"), m.catalog.first { it.key == "booking.confirmed" }.audiences)
        // security.breach carries no audiences object -> legacy "business" mapping.
        assertEquals(setOf("business"), m.catalog.first { it.key == "security.breach" }.audiences)
    }

    @Test
    fun decodesStreamsAndLockReason() = runTest {
        val o = sampleMatrix().overrides.getValue("booking.confirmed")
        assertEquals("Bookings stay confirmed in writing", o.lockReason)
        assertEquals(true, o.streams["kinfolk"]?.channels?.get("sms"))
        assertEquals(true, o.streams["kinfolk"]?.locked?.get("email"))
        assertEquals(false, o.streams["business"]?.enabled)
        assertNull(o.streams["kinfolk"]?.enabled)        // absent field stays null (falls to flat)
        assertNull(o.streams["kinfolk"]?.lockedEnabled)  // absent field stays null (falls to flat)
    }

    @Test
    fun streamEffectiveMergesDecodedStreamsOverFlat() = runTest {
        val m = sampleMatrix()
        val key = "booking.confirmed"
        assertTrue(streamEffectiveChannel(m, key, "kinfolk", "sms"))    // stream value wins over flat false
        assertFalse(streamEffectiveChannel(m, key, "business", "sms"))  // field absent in stream -> flat
        assertFalse(streamEffectiveChannel(m, key, "staff", "sms"))     // stream absent entirely -> flat
        assertFalse(streamEffectiveEnabled(m, key, "business"))         // stream gate off
        assertTrue(streamEffectiveEnabled(m, key, "kinfolk"))           // enabled unset in stream -> flat true
        assertTrue(streamEffectiveChannelLocked(m, key, "kinfolk", "email"))
        assertFalse(streamEffectiveChannelLocked(m, key, "business", "email"))
        assertEquals("Bookings stay confirmed in writing", lockReasonFor(m, key))
        assertNull(lockReasonFor(m, "security.breach"))
    }

    @Test
    fun effectiveStateAppliesOverrideElseDefaultsOn() = runTest {
        val m = sampleMatrix()
        // Flat override turned sms off; email/push inherit default = on.
        assertFalse(m.effectiveChannel("booking.confirmed", "sms"))
        assertTrue(m.effectiveChannel("booking.confirmed", "email"))
        assertTrue(m.effectiveChannel("booking.confirmed", "push"))
        // No override for security.breach -> everything defaults on.
        assertTrue(m.effectiveEnabled("security.breach"))
        assertTrue(m.effectiveChannel("security.breach", "email"))
    }

    @Test
    fun saveEncodesStreamsAndLockReason() = runTest {
        var sentPayload = ""
        val r = repo { _, p -> sentPayload = p; WriteResult.Ok("{}") }
        val override = NotificationOverride(
            enabled = true,
            channels = mapOf("sms" to false),
            lockReason = "House rule: money talk stays on",
            streams = mapOf(
                "kinfolk" to StreamGate(
                    enabled = false,
                    channels = mapOf("push" to true),
                    lockedEnabled = true,
                    locked = mapOf("email" to true, "sms" to false),
                ),
                "staff" to StreamGate(lockedEnabled = false),
                "business" to StreamGate(), // fully empty gate must be omitted
            ),
        )
        assertTrue(r.saveOverride("booking.confirmed", override) is WriteResult.Ok)
        val ov = Json.parseToJsonElement(sentPayload).jsonObject["override"]!!.jsonObject
        assertEquals("House rule: money talk stays on", ov["lockReason"]!!.jsonPrimitive.content)
        val streams = ov["streams"]!!.jsonObject
        val kin = streams["kinfolk"]!!.jsonObject
        assertEquals(false, kin["enabled"]!!.jsonPrimitive.boolean)
        assertEquals(true, kin["channels"]!!.jsonObject["push"]!!.jsonPrimitive.boolean)
        assertEquals(true, kin["lockedEnabled"]!!.jsonPrimitive.boolean)
        assertEquals(true, kin["locked"]!!.jsonObject["email"]!!.jsonPrimitive.boolean)
        assertNull(kin["locked"]!!.jsonObject["sms"])   // locked maps carry literal-true only
        // A stream may UNLOCK a flat whole-notification lock with an explicit false.
        assertEquals(false, streams["staff"]!!.jsonObject["lockedEnabled"]!!.jsonPrimitive.boolean)
        assertNull(streams["business"])                  // empty gate omitted
    }

    @Test
    fun saveOmitsLockReasonWhenNullAndSendsEmptyStringToClear() = runTest {
        var sentPayload = ""
        val r = repo { _, p -> sentPayload = p; WriteResult.Ok("{}") }

        assertTrue(r.saveOverride("k", NotificationOverride()) is WriteResult.Ok)
        val ov1 = Json.parseToJsonElement(sentPayload).jsonObject["override"]!!.jsonObject
        assertNull(ov1["lockReason"]) // untouched reason never goes on the wire
        assertNull(ov1["streams"])    // no stream edits -> no streams key

        assertTrue(r.saveOverride("k", NotificationOverride(lockReason = "")) is WriteResult.Ok)
        val ov2 = Json.parseToJsonElement(sentPayload).jsonObject["override"]!!.jsonObject
        assertEquals("", ov2["lockReason"]!!.jsonPrimitive.content) // explicit clear
    }

    @Test
    fun saveAndDeleteForwardErrorsLoudly() = runTest {
        val errRepo = repo { _, _ -> WriteResult.Err("boom") }
        assertTrue(errRepo.saveOverride("k", NotificationOverride()) is WriteResult.Err)
        assertTrue(errRepo.deleteOverride("k") is WriteResult.Err)
    }
}
