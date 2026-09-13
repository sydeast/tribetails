package com.tribetails.auntieos.ui.communicate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stage 2 step 6: pure broadcast validation + criteria payload + decode helpers. */
class BroadcastTest {

    // ── broadcastBlocker ─────────────────────────────────────────────────────
    @Test fun blocksNoChannels() =
        assertNotNull(broadcastBlocker(emptySet(), BroadcastCriteria(SegmentKind.All), "S", "B"))

    @Test fun blocksEmailNeedsSubject() =
        assertNotNull(broadcastBlocker(setOf(BroadcastChannel.Email), BroadcastCriteria(SegmentKind.All), " ", "B"))

    @Test fun blocksInAppNeedsSubject() =
        assertNotNull(broadcastBlocker(setOf(BroadcastChannel.InApp), BroadcastCriteria(SegmentKind.All), "", "B"))

    @Test fun blocksBodyBlank() =
        assertNotNull(broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.All), "", " "))

    @Test fun blocksStatusAudienceEmpty() =
        assertNotNull(broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.Status, statuses = emptyList()), "", "B"))

    @Test fun blocksTagAudienceEmpty() =
        assertNotNull(broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.Tags, tags = emptyList()), "", "B"))

    @Test fun passesSmsAll() =
        assertNull(broadcastBlocker(setOf(BroadcastChannel.Sms), BroadcastCriteria(SegmentKind.All), "", "B"))

    @Test fun passesEmailWithSubject() =
        assertNull(broadcastBlocker(setOf(BroadcastChannel.Email), BroadcastCriteria(SegmentKind.All), "S", "B"))

    // ── segmentSaveBlocker ───────────────────────────────────────────────────
    @Test fun segmentSaveNeedsName() {
        assertNotNull(segmentSaveBlocker(" ", BroadcastCriteria(SegmentKind.All)))
        assertNull(segmentSaveBlocker("VIPs", BroadcastCriteria(SegmentKind.All)))
    }

    // ── criteria payload ─────────────────────────────────────────────────────
    @Test fun criteriaAllPayloadOnlyKind() {
        val p = BroadcastCriteria(SegmentKind.All).toPayload()
        assertEquals("all", p["kind"])
        assertNull(p["statuses"])
        assertNull(p["tags"])
    }

    @Test fun criteriaTagsPayloadFiltersBlanks() {
        val p = BroadcastCriteria(SegmentKind.Tags, tags = listOf("vip", " ", "monthly"), tagMatch = TagMatch.All).toPayload()
        assertEquals("tags", p["kind"])
        assertEquals("all", p["tagMatch"])
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("vip", "monthly"), p["tags"] as List<String>)
    }

    // ── decode ───────────────────────────────────────────────────────────────
    @Test fun decodeSegmentsParsesList() {
        val raw = mapOf(
            "segments" to listOf(
                mapOf("id" to "s1", "name" to "VIPs", "description" to "d", "updatedAtMs" to 20.0,
                    "criteria" to mapOf("kind" to "tags", "tags" to listOf("vip"), "tagMatch" to "any")),
            ),
        )
        val segs = decodeSegments(raw)
        assertEquals(1, segs.size)
        assertEquals("VIPs", segs[0].name)
        assertEquals(SegmentKind.Tags, segs[0].criteria.kind)
        assertEquals(20L, segs[0].updatedAtMs)
    }

    @Test fun decodeSegmentsEmptyWhenAbsent() =
        assertEquals(0, decodeSegments(mapOf("ok" to true)).size)

    @Test fun decodeBroadcastResultParsesCounts() {
        val raw = mapOf(
            "broadcastId" to "b1",
            "recipientCount" to 3.0,
            "perChannel" to mapOf(
                "email" to mapOf("sent" to 2.0, "skipped" to 1.0, "failed" to 0.0),
                "sms" to mapOf("sent" to 3.0, "skipped" to 0.0, "failed" to 0.0),
            ),
        )
        val r = decodeBroadcastResult(raw)
        assertEquals("b1", r.broadcastId)
        assertEquals(3, r.recipientCount)
        assertEquals(ChannelCounts(2, 1, 0), r.perChannel["email"])
    }

    @Test fun decodeSavedSegmentIdReadsId() =
        assertEquals("seg9", decodeSavedSegmentId(mapOf("ok" to true, "id" to "seg9")))

    // ── error text + summary ─────────────────────────────────────────────────
    @Test fun errorTextMapsSentinels() {
        assertTrue(broadcastErrorText("x no_recipients y").contains("no kinfolk", ignoreCase = true))
        assertTrue(broadcastErrorText("x broadcast_all_failed y").contains("failed", ignoreCase = true))
        assertEquals("raw boom", broadcastErrorText("raw boom"))
        // #823's two, from stopBroadcast. Both mean the press changed nothing,
        // and both are good news, which the raw sentinel does not convey.
        assertTrue(
            broadcastErrorText("FAILED_PRECONDITION: already_finished")
                .contains("already finished", ignoreCase = true),
        )
        assertTrue(
            broadcastErrorText("FAILED_PRECONDITION: already_stopping")
                .contains("already going through", ignoreCase = true),
        )
    }

    @Test fun summaryMentionsCountAndChannel() {
        val s = broadcastSummary(BroadcastResult("b1", 5, mapOf("email" to ChannelCounts(4, 1, 0))))
        assertTrue(s.contains("5"))
        assertTrue(s.contains("email"))
    }
}
