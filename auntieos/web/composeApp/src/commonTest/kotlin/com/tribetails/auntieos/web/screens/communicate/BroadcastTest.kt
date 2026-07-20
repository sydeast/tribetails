package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Stage 2 step 6: pure broadcast validation + criteria codec + decode helpers. */
class BroadcastTest {

    // ── broadcastBlocker ─────────────────────────────────────────────────────
    @Test fun blocksWhenNoChannels() {
        val b = broadcastBlocker(emptySet(), BroadcastCriteria(SegmentKind.All), "S", "Body")
        assertNotNull(b)
    }

    @Test fun blocksWhenEmailNeedsSubject() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Email), BroadcastCriteria(SegmentKind.All), "  ", "Body")
        assertNotNull(b)
    }

    @Test fun blocksWhenInAppNeedsSubject() {
        val b = broadcastBlocker(setOf(BroadcastChannel.InApp), BroadcastCriteria(SegmentKind.All), "", "Body")
        assertNotNull(b)
    }

    @Test fun blocksWhenBodyBlank() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.All), "", "  ")
        assertNotNull(b)
    }

    @Test fun blocksWhenStatusAudienceEmpty() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.Status, statuses = emptyList()), "", "Body")
        assertNotNull(b)
    }

    @Test fun blocksWhenTagAudienceEmpty() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.Tags, tags = emptyList()), "", "Body")
        assertNotNull(b)
    }

    @Test fun passesValidSmsAllAudience() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.All), "", "Body")
        assertNull(b)
    }

    @Test fun passesValidEmailWithSubject() {
        val b = broadcastBlocker(setOf(BroadcastChannel.Email), BroadcastCriteria(SegmentKind.All), "Subject", "Body")
        assertNull(b)
    }

    // ── segmentSaveBlocker ───────────────────────────────────────────────────
    @Test fun segmentSaveNeedsName() {
        assertNotNull(segmentSaveBlocker("  ", BroadcastCriteria(SegmentKind.All)))
        assertNull(segmentSaveBlocker("VIPs", BroadcastCriteria(SegmentKind.All)))
    }

    @Test fun segmentSaveTagsNeedTags() {
        assertNotNull(segmentSaveBlocker("T", BroadcastCriteria(SegmentKind.Tags, tags = emptyList())))
        assertNull(segmentSaveBlocker("T", BroadcastCriteria(SegmentKind.Tags, tags = listOf("vip"))))
    }

    // ── criteriaToJson ───────────────────────────────────────────────────────
    @Test fun criteriaAllJsonOnlyKind() {
        val o = criteriaToJson(BroadcastCriteria(SegmentKind.All))
        assertEquals("all", o["kind"]?.jsonPrimitive?.contentOrNull)
        assertNull(o["statuses"])
        assertNull(o["tags"])
    }

    @Test fun criteriaTagsJsonCarriesTagsAndMatch() {
        val o = criteriaToJson(BroadcastCriteria(SegmentKind.Tags, tags = listOf("vip", " ", "monthly"), tagMatch = TagMatch.All))
        assertEquals("tags", o["kind"]?.jsonPrimitive?.contentOrNull)
        assertEquals("all", o["tagMatch"]?.jsonPrimitive?.contentOrNull)
        // blank tag filtered out
        assertTrue(o.toString().contains("vip") && o.toString().contains("monthly"))
    }

    // ── round-trip criteria ──────────────────────────────────────────────────
    @Test fun criteriaRoundTrip() {
        val orig = BroadcastCriteria(SegmentKind.Status, statuses = listOf("active", "prospect"))
        val back = decodeCriteria(criteriaToJson(orig))
        assertEquals(SegmentKind.Status, back.kind)
        assertEquals(listOf("active", "prospect"), back.statuses)
    }

    // ── decodeSegments ───────────────────────────────────────────────────────
    @Test fun decodeSegmentsParsesList() {
        val json = """{"ok":true,"segments":[
            {"id":"s1","name":"VIPs","description":"Tags (any): vip","updatedAtMs":20,"criteria":{"kind":"tags","tags":["vip"],"tagMatch":"any"}},
            {"id":"s2","name":"Active","description":"x","updatedAtMs":10,"criteria":{"kind":"status","statuses":["active"]}}
        ]}"""
        val segs = decodeSegments(json)
        assertEquals(2, segs.size)
        assertEquals("VIPs", segs[0].name)
        assertEquals(SegmentKind.Tags, segs[0].criteria.kind)
        assertEquals(20L, segs[0].updatedAtMs)
    }

    @Test fun decodeSegmentsEmptyWhenAbsent() {
        assertEquals(0, decodeSegments("""{"ok":true}""").size)
    }

    // ── decodeBroadcastResult ────────────────────────────────────────────────
    @Test fun decodeBroadcastResultParsesCounts() {
        val json = """{"ok":true,"broadcastId":"b1","recipientCount":3,"perChannel":{
            "email":{"sent":2,"skipped":1,"failed":0},"sms":{"sent":3,"skipped":0,"failed":0}}}"""
        val r = decodeBroadcastResult(json)
        assertEquals("b1", r.broadcastId)
        assertEquals(3, r.recipientCount)
        assertEquals(ChannelCounts(2, 1, 0), r.perChannel["email"])
        assertEquals(ChannelCounts(3, 0, 0), r.perChannel["sms"])
    }

    // ── broadcastErrorText ───────────────────────────────────────────────────
    @Test fun errorTextMapsSentinels() {
        assertTrue(broadcastErrorText("FAILED_PRECONDITION: no_recipients").contains("no kinfolk", ignoreCase = true))
        assertTrue(broadcastErrorText("UNAVAILABLE: broadcast_all_failed").contains("failed", ignoreCase = true))
        assertEquals("raw provider boom", broadcastErrorText("raw provider boom"))
    }

    @Test fun summaryMentionsRecipientCountAndChannels() {
        val r = BroadcastResult("b1", 5, mapOf("email" to ChannelCounts(4, 1, 0)))
        val s = broadcastSummary(r)
        assertTrue(s.contains("5"))
        assertTrue(s.contains("email"))
    }
}
