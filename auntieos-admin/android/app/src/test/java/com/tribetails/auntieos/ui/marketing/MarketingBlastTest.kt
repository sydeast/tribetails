package com.tribetails.auntieos.ui.marketing

import com.tribetails.auntieos.ui.communicate.BroadcastCriteria
import com.tribetails.auntieos.ui.communicate.SegmentKind
import com.tribetails.auntieos.ui.communicate.TagMatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * Pure model + validation for Marketing blasts. Mirrors the React admin's
 * `lib/marketingBlastEdit.test.ts` and `api/marketingBlasts.test.ts`, because
 * the two clients hand-build the same payload and a rule that drifts on one is
 * a rule that no longer exists.
 */
class MarketingBlastTest {

    private val utc = ZoneId.of("UTC")

    // ── audience ─────────────────────────────────────────────────────────────

    @Test
    fun `segment mode sends a segmentId and nothing else`() {
        val a = blastAudience(AudienceMode.Segment, "seg1", BroadcastCriteria(), listOf("u1"))
        assertEquals(mapOf("segmentId" to "seg1"), a?.toPayload())
    }

    @Test
    fun `criteria mode sends criteria and nothing else`() {
        val a = blastAudience(AudienceMode.Criteria, "seg1", BroadcastCriteria(), listOf("u1"))
        assertEquals(mapOf("criteria" to mapOf("kind" to "all")), a?.toPayload())
    }

    @Test
    fun `uids mode sends the account list and nothing else`() {
        val a = blastAudience(AudienceMode.Uids, "seg1", BroadcastCriteria(), listOf("u1", "u2"))
        assertEquals(mapOf("audienceUids" to listOf("u1", "u2")), a?.toPayload())
    }

    @Test
    fun `an empty chosen mode is null, never a silent fallback to everyone`() {
        assertNull(blastAudience(AudienceMode.Segment, null, BroadcastCriteria(), listOf("u1")))
        assertNull(blastAudience(AudienceMode.Uids, "seg1", BroadcastCriteria(), emptyList()))
        assertNull(
            blastAudience(
                AudienceMode.Criteria,
                "seg1",
                BroadcastCriteria(kind = SegmentKind.Status, statuses = emptyList()),
                listOf("u1"),
            ),
        )
        assertNull(
            blastAudience(
                AudienceMode.Criteria,
                "seg1",
                BroadcastCriteria(kind = SegmentKind.Tags, tags = listOf("  ")),
                listOf("u1"),
            ),
        )
    }

    @Test
    fun `a tag criteria carries the match mode onto the wire`() {
        val a = blastAudience(
            AudienceMode.Criteria,
            null,
            BroadcastCriteria(kind = SegmentKind.Tags, tags = listOf("vip"), tagMatch = TagMatch.All),
            emptyList(),
        )
        assertEquals(
            mapOf("criteria" to mapOf("kind" to "tags", "tags" to listOf("vip"), "tagMatch" to "all")),
            a?.toPayload(),
        )
    }

    // ── uid parsing ──────────────────────────────────────────────────────────

    @Test
    fun `parseUidList splits on commas spaces and newlines, because a pasted column has no commas`() {
        assertEquals(listOf("u1", "u2", "u3", "u4"), parseUidList("u1,u2\nu3 u4"))
    }

    @Test
    fun `parseUidList de-dupes, so one account is never scheduled the same blast twice`() {
        assertEquals(listOf("u1", "u2"), parseUidList(" u1 , ,u1,\n\nu2 "))
    }

    @Test
    fun `parseUidList returns empty for a blank field`() {
        assertTrue(parseUidList("  \n ").isEmpty())
    }

    // ── fire time ────────────────────────────────────────────────────────────

    @Test
    fun `fireAtMsFrom resolves the pair as local wall-clock time`() {
        val ms = fireAtMsFrom("2026-06-03", "09:00", utc)
        assertEquals("2026-06-03 09:00", fireLabel(ms!!, utc))
    }

    @Test
    fun `fireAtMsFrom is null when either half is missing, rather than defaulting to today`() {
        assertNull(fireAtMsFrom("", "09:00", utc))
        assertNull(fireAtMsFrom("2026-06-03", "", utc))
    }

    @Test
    fun `fireAtMsFrom is null for an unparseable pair`() {
        assertNull(fireAtMsFrom("not-a-date", "09:00", utc))
        assertNull(fireAtMsFrom("2026-06-03", "25:99", utc))
    }

    @Test
    fun `fireLabel refuses to invent a date for a zero timestamp`() {
        assertEquals("no send time", fireLabel(0L, utc))
    }

    // ── merge fields ─────────────────────────────────────────────────────────

    @Test
    fun `mergeFieldsToData builds the record from named rows`() {
        assertEquals(mapOf("headline" to "Hello"), mergeFieldsToData(listOf(MergeFieldRow(" headline ", "Hello"))))
    }

    @Test
    fun `mergeFieldsToData drops a row with no key, which could never match a template token`() {
        assertTrue(mergeFieldsToData(listOf(MergeFieldRow("", "orphan"))).isEmpty())
    }

    @Test
    fun `mergeFieldsToData lets a later row win, so the last thing typed is what is sent`() {
        val data = mergeFieldsToData(listOf(MergeFieldRow("cta", "first"), MergeFieldRow("cta", "second")))
        assertEquals(mapOf("cta" to "second"), data)
    }

    @Test
    fun `mergeFieldsToData keeps a blank VALUE, which is a real choice unlike a blank key`() {
        assertEquals(mapOf("note" to ""), mergeFieldsToData(listOf(MergeFieldRow("note", ""))))
    }

    // ── blocker ──────────────────────────────────────────────────────────────

    private val now = 1_800_000_000_000L
    private val anyAudience = BlastAudience.Criteria(BroadcastCriteria())

    @Test
    fun `blocker complains about the audience before the time`() {
        assertEquals("Choose an audience first.", blastBlocker(null, null, now, null))
    }

    @Test
    fun `blocker wants a send time`() {
        assertEquals("Pick a date and a time to send.", blastBlocker(anyAudience, null, now, null))
    }

    @Test
    fun `blocker refuses a time the server would refuse as past`() {
        assertEquals("That send time has already passed.", blastBlocker(anyAudience, now - 120_000L, now, null))
    }

    @Test
    fun `blocker allows a time inside the server's own 60 second grace window`() {
        assertNull(blastBlocker(anyAudience, now - 30_000L, now, null))
    }

    @Test
    fun `blocker stops a blast a preview proved reaches nobody`() {
        assertEquals(
            "This audience reaches nobody. Widen it, or check who has opted in.",
            blastBlocker(anyAudience, now + 60_000L, now, 0),
        )
    }

    @Test
    fun `blocker does not stop an unpreviewed blast, because null is not zero`() {
        assertNull(blastBlocker(anyAudience, now + 60_000L, now, null))
    }

    // ── decode ───────────────────────────────────────────────────────────────

    @Test
    fun `decodeBlastReach reads all four counts`() {
        val reach = decodeBlastReach(
            mapOf(
                "description" to "All active kinfolk",
                "matched" to 10,
                "noLinkedAccount" to 2,
                "suppressedByPrefs" to 3,
                "reachable" to 5,
            ),
        )
        assertEquals(BlastReach("All active kinfolk", 10, 2, 3, 5), reach)
    }

    @Test
    fun `decodeBlastReach reads a missing count as zero rather than throwing`() {
        assertEquals(BlastReach(), decodeBlastReach(null))
    }

    @Test
    fun `decodeBlasts drops a row with no id, which could never be cancelled`() {
        val rows = decodeBlasts(
            mapOf("blasts" to listOf(mapOf("id" to "", "key" to "x"), mapOf("id" to "b1", "key" to "y"))),
        )
        assertEquals(listOf("b1"), rows.map { it.id })
    }

    @Test
    fun `decodeBlasts orders newest fire time first`() {
        val rows = decodeBlasts(
            mapOf(
                "blasts" to listOf(
                    mapOf("id" to "b1", "fireAtMs" to 100),
                    mapOf("id" to "b2", "fireAtMs" to 900),
                ),
            ),
        )
        assertEquals(listOf("b2", "b1"), rows.map { it.id })
    }

    @Test
    fun `an unknown status reads as scheduled, so the row keeps a Cancel button`() {
        val rows = decodeBlasts(mapOf("blasts" to listOf(mapOf("id" to "b1", "status" to "something-new"))))
        assertEquals(BlastStatus.Scheduled, rows.first().status)
    }

    @Test
    fun `a row with no title falls back to its campaign key`() {
        val rows = decodeBlasts(mapOf("blasts" to listOf(mapOf("id" to "b1", "key" to "survey.event"))))
        assertEquals("survey.event", rows.first().displayName)
    }

    @Test
    fun `decodeScheduleResult reads the counts`() {
        val res = decodeScheduleResult(mapOf("blastId" to "b1", "dispatched" to 9, "suppressed" to 2, "failed" to 1))
        assertEquals(ScheduleBlastResult("b1", 0, 0, 9, 2, 1), res)
        assertEquals("9 queued, 2 suppressed, 1 failed.", scheduleSummary(res))
    }

    @Test
    fun `scheduleSummary omits the failure clause when nothing failed`() {
        assertEquals("9 queued, 2 suppressed.", scheduleSummary(ScheduleBlastResult(dispatched = 9, suppressed = 2)))
    }

    @Test
    fun `decodeCancelledCount reads the removed count`() {
        assertEquals(12, decodeCancelledCount(mapOf("cancelled" to 12)))
        assertEquals(0, decodeCancelledCount(null))
    }

    // ── error text ───────────────────────────────────────────────────────────

    @Test
    fun `server sentinels become operator-facing sentences`() {
        assertTrue(blastErrorText("failed-precondition: no_recipients").contains("MyTribe account"))
        assertTrue(blastErrorText("audience_too_large: 6000 recipients").contains("5000"))
        assertTrue(blastErrorText("already_fired").contains("already gone out"))
        assertTrue(blastErrorText("already_cancelled").contains("already cancelled"))
    }

    @Test
    fun `an unrecognised error passes through verbatim rather than being softened away`() {
        assertEquals("permission-denied", blastErrorText("permission-denied"))
    }

    // ── row meta / confirm line ──────────────────────────────────────────────

    @Test
    fun `a scheduled row's meta line does not claim send counts it does not have yet`() {
        val row = MarketingBlastRow(
            id = "b1",
            key = "newsletter.announcement",
            title = "June",
            fireAtMs = fireAtMsFrom("2026-06-03", "09:00", utc)!!,
            status = BlastStatus.Scheduled,
            audienceDescription = "All active kinfolk",
            matched = 9,
            noLinkedAccount = 0,
            dispatched = 9,
            suppressed = 0,
            failed = 0,
        )
        assertTrue(blastMeta(row).contains("All active kinfolk"))
        assertTrue(!blastMeta(row).contains("sent"))
    }

    @Test
    fun `a sent row's meta line carries what actually went out`() {
        val row = MarketingBlastRow(
            id = "b2",
            key = "survey.event",
            title = "",
            fireAtMs = 1L,
            status = BlastStatus.Sent,
            audienceDescription = "Tags (any): vip",
            matched = 4,
            noLinkedAccount = 1,
            dispatched = 3,
            suppressed = 1,
            failed = 0,
        )
        assertTrue(blastMeta(row).contains("3 sent, 1 suppressed"))
    }

    @Test
    fun `confirmLine names the campaign, the audience and the time`() {
        val state = MarketingBlastsUiState(
            campaignKey = MarketingKey.Survey,
            mode = AudienceMode.Uids,
            uidsText = "u1, u2",
            sendDate = "2026-06-03",
            sendTime = "09:00",
        )
        val line = confirmLine(state)
        assertTrue(line.startsWith("Survey or event to 2 chosen accounts, firing "))
    }

    @Test
    fun `confirmLine says so plainly when no time has been picked`() {
        assertTrue(confirmLine(MarketingBlastsUiState()).endsWith("firing no time yet."))
    }
}
