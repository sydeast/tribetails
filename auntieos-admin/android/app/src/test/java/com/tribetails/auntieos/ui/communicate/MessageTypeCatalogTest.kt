package com.tribetails.auntieos.ui.communicate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * The seven message types the composer offers, and the exact wire value each
 * one submits.
 *
 * A message type is a COPY FORMAT, not a delivery channel: `push` here asks the
 * generator for a notification-shelf line and is unrelated to the broadcast push
 * channel that delivers one. The web twin of this table is
 * `auntieos-admin/src/lib/personalizeCompose.ts`, and the bidirectional drift
 * guard in `web/functions/test/generate.test.js` pins both against the
 * function's own ALLOWED_TYPES so neither can quietly drop a format again.
 */
class MessageTypeCatalogTest {
    @Test
    fun `offers all seven types in the operator's order`() {
        assertEquals(
            listOf("email", "sms", "push", "social_post", "blog_post", "general", "visit_report"),
            communicateMessageTypeOptions(),
        )
    }
    // One case per type, asserting the exact wire value submitted. The labels are
    // the operator's words; the values are the server's, and KinTale is where
    // they deliberately differ.
    @Test fun `Email submits email`() = assertWire("Email", "email")
    @Test fun `SMS submits sms`() = assertWire("SMS", "sms")
    @Test fun `Push submits push`() = assertWire("Push", "push")
    @Test fun `Social submits social_post`() = assertWire("Social", "social_post")
    @Test fun `Blog submits blog_post`() = assertWire("Blog", "blog_post")
    @Test fun `General submits general`() = assertWire("General", "general")
    @Test fun `KinTale submits visit_report, never a kintale wire value`() {
        assertWire("KinTale", "visit_report")
        assertFalse(communicateMessageTypeOptions().contains("kintale"))
    }
    @Test
    fun `rejects an unknown type rather than offering it`() {
        assertFalse(communicateMessageTypeOptions().contains("carrier_pigeon"))
        // An unknown wire value has no label to render, so the raw value shows
        // rather than a crash or a silently wrong chip.
        assertEquals("carrier_pigeon", communicateMessageTypeLabel("carrier_pigeon"))
    }
    @Test
    fun `every offered type has a label`() {
        for (wire in communicateMessageTypeOptions()) {
            assertTrue("no label for $wire", communicateMessageTypeLabel(wire) != wire)
        }
    }
    private fun assertWire(label: String, wire: String) {
        val match = communicateMessageTypeOptions().filter { communicateMessageTypeLabel(it) == label }
        assertEquals("expected exactly one chip labelled $label", listOf(wire), match)
    }
}
