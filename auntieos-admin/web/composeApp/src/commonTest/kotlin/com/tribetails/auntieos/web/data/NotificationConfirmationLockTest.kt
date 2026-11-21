package com.tribetails.auntieos.web.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Ruling on #2382 (2026-11-20): payment, invoice, KinTale and booking
 * confirmations are required on and cannot be disabled. The desktop console's
 * gate draws the five rows locked on for Kinfolk, says so in the wording admin
 * web and Android use, and no longer captions any row "Always on".
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationConfirmationLockTest {

    private val json = """
        {
          "catalog": [
            { "key":"invoice.new", "label":"New invoice or quote issued", "category":"invoice",
              "audience":"both", "audiences": { "kinfolk": true, "business": true },
              "allowedChannels":["email","sms","push"], "required":{"email":true},
              "alwaysEnabled":true, "alwaysEnabledStreams": { "kinfolk": true },
              "lockedOnStreams": { "kinfolk": true, "business": false } },
            { "key":"kincare.booking.cancel", "label":"KinCare booking canceled", "category":"visit",
              "audience":"both", "audiences": { "kinfolk": true, "business": true },
              "allowedChannels":["email","sms","push"], "required":{"email":true},
              "alwaysEnabled":true, "alwaysEnabledStreams": { "kinfolk": true } }
          ],
          "overrides": {},
          "updatedAtMs": null
        }
    """.trimIndent()

    private suspend fun catalog(): List<NotificationCatalogEntry> =
        (CloudNotificationOverridesRepository { _, _ -> WriteResult.Ok(json) }.getMatrix() as WriteResult.Ok).value.catalog

    @Test
    fun decodesLockedOnStreams_literalTrueOnly_andAbsenceAsNoLock() = runTest {
        val c = catalog()
        assertEquals(setOf("kinfolk"), c.first { it.key == "invoice.new" }.lockedOnStreams)
        assertEquals(emptySet<String>(), c.first { it.key == "kincare.booking.cancel" }.lockedOnStreams)
    }

    @Test
    fun lockedForTheKinfolkCopyOnly_emailBeingThePinnedChannel() = runTest {
        val invoice = catalog().first { it.key == "invoice.new" }
        assertTrue(invoice.lockedOnFor("kinfolk"))
        assertFalse(invoice.lockedOnFor("business"))
        assertTrue(invoice.lockedOnChannel("kinfolk", "email"))
        assertFalse(invoice.lockedOnChannel("kinfolk", "push"))
    }

    @Test
    fun captionIsRequiredForKinfolk_meantToStayOnForTheRest_neverAlwaysOn() = runTest {
        val c = catalog()
        val invoice = c.first { it.key == "invoice.new" }
        val cancel = c.first { it.key == "kincare.booking.cancel" }
        assertEquals("Required for Kinfolk", invoice.gateRowCaption("kinfolk"))
        assertNull(invoice.gateRowCaption("business"))
        assertEquals("Meant to stay on", cancel.gateRowCaption("kinfolk"))
        for (caption in listOfNotNull(invoice.gateRowCaption("kinfolk"), cancel.gateRowCaption("kinfolk"))) {
            assertFalse(caption.lowercase().contains("always on"))
        }
        assertEquals(
            "Payment, invoice, KinTale and booking confirmations cannot be turned off for Kinfolk, " +
                "and neither can their email. Text and push can still be changed.",
            NOTIF_REQUIRED_FOR_KINFOLK_DETAIL,
        )
    }

    @Test
    fun keptLockedOn_savesAnOldFlatOffWithTheKinfolkCopyAndEmailOn() = runTest {
        val invoice = catalog().first { it.key == "invoice.new" }
        val next = NotificationOverride(enabled = false, channels = mapOf("email" to false, "sms" to false))
            .keptLockedOn(invoice)
        assertEquals(true, next.streams["kinfolk"]?.enabled)
        assertEquals(true, next.streams["kinfolk"]?.channels?.get("email"))
        assertFalse(next.enabled)
        assertEquals(false, next.channels["sms"])
    }

    @Test
    fun keptLockedOn_leavesAnOnOverrideAndAnUnlockedRowAlone() = runTest {
        val c = catalog()
        val ownerOff = NotificationOverride(streams = mapOf("business" to StreamGate(enabled = false)))
        assertSame(ownerOff, ownerOff.keptLockedOn(c.first { it.key == "invoice.new" }))
        val off = NotificationOverride(enabled = false)
        assertSame(off, off.keptLockedOn(c.first { it.key == "kincare.booking.cancel" }))
    }
}
