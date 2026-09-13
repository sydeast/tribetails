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
    fun `decodeCancelResult reads the removed count`() {
        val res = decodeCancelResult(mapOf("cancelled" to 12, "stopped" to true, "neverQueued" to 0))
        assertEquals(12, res.cancelled)
        assertEquals(true, res.stopped)
        assertEquals(0, decodeCancelResult(null).cancelled)
    }

    /**
     * #823. A cancel that lands mid fan-out cannot prove the worker stopped, so
     * the server says so and this must carry it through rather than flattening
     * it to a count the screen would announce as final.
     */
    @Test
    fun `decodeCancelResult carries through that a mid fan-out cancel has not finished`() {
        val res = decodeCancelResult(mapOf("cancelled" to 120, "stopped" to false, "neverQueued" to 780))
        assertEquals(false, res.stopped)
        assertEquals(780, res.neverQueued)
    }

    @Test
    fun `decodeCancelResult reads a reply with no stop fields as a cancel that DID finish`() {
        // A backend older than #823 really did finish the cancel synchronously,
        // so `stopped` defaults true. Defaulting the other way would put "It
        // finishes stopping within a minute" under every cancel on a deployment
        // where nothing is left to stop.
        assertEquals(true, decodeCancelResult(mapOf("cancelled" to 4)).stopped)
    }

    @Test
    fun `cancelNotice says Cancelled only when the fan-out was already finished`() {
        assertEquals(
            "Cancelled. 3 queued notifications removed.",
            cancelNotice(CancelBlastResult(cancelled = 3, stopped = true)),
        )
        assertEquals(
            true,
            cancelNotice(CancelBlastResult(cancelled = 1, stopped = true)).contains("1 queued notification removed"),
        )
    }

    @Test
    fun `cancelNotice refuses to claim a mid fan-out cancel finished`() {
        // The callable stamps a request and the sweep confirms it. Saying
        // "Cancelled" here would restore exactly the dishonesty #823 removed
        // from the server: a row that reads cancelled while the loop keeps
        // queueing.
        val text = cancelNotice(CancelBlastResult(cancelled = 120, stopped = false, neverQueued = 780))
        assertEquals(true, text.startsWith("Stopping."))
        assertEquals(true, text.contains("780 were never queued"))
        assertEquals(false, text.contains("Cancelled."))
    }

    // ── #823: the still-queueing progress line ───────────────────────────────

    @Test
    fun `sendingLabel reads as the mock does, how many of how many`() {
        assertEquals("256 of 410 queued", sendingLabel(256, 410, stalled = false))
    }

    @Test
    fun `sendingLabel names a stalled fan-out rather than calling it slow`() {
        // "still sending" about a campaign that stopped moving twenty minutes
        // ago is a progress bar telling a lie.
        val text = sendingLabel(256, 410, stalled = true)
        assertEquals(true, text.startsWith("Stopped at 256 of 410"))
        assertEquals(true, text.contains("picks up again"))
    }

    @Test
    fun `sendingLabel invents no denominator for a campaign written before the roster existed`() {
        assertEquals("12 queued", sendingLabel(12, 0, stalled = false))
    }

    @Test
    fun `scheduleNotice says where a handed-off fan-out reached and that it continues`() {
        val text = scheduleNotice(
            ScheduleBlastResult(dispatched = 61, suppressed = 4, pending = true, queued = 65, audienceSize = 900),
            "Fri 9am",
        )
        assertEquals(true, text.contains("Scheduled for Fri 9am"))
        assertEquals(true, text.contains("65 of 900"))
        assertEquals(true, text.contains("carries on in the background"))
        // Never the counts, which describe one leg and not the send.
        assertEquals(false, text.contains("61 queued, 4 suppressed"))
    }

    @Test
    fun `decodeBlasts reads the fan-out progress a sending campaign carries`() {
        val rows = decodeBlasts(
            mapOf(
                "blasts" to listOf(
                    mapOf(
                        "id" to "b1",
                        "status" to "sending",
                        "fanoutState" to "running",
                        "queued" to 256,
                        "audienceSize" to 410,
                    ),
                ),
            ),
        )
        assertEquals(BlastStatus.Sending, rows[0].status)
        assertEquals(BlastFanoutState.Running, rows[0].fanoutState)
        assertEquals(256, rows[0].queued)
        assertEquals(410, rows[0].audienceSize)
        assertEquals(256f / 410f, rows[0].progress)
    }

    @Test
    fun `a campaign from a backend with no progress fields is not drawn as in flight`() {
        // A progress bar that could never move would be worse than none.
        val rows = decodeBlasts(mapOf("blasts" to listOf(mapOf("id" to "b1", "status" to "sent"))))
        assertEquals(BlastFanoutState.Complete, rows[0].fanoutState)
        assertEquals(0f, rows[0].progress)
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
    fun `a failed row that queued nothing says so, and one that queued copies does not`() {
        // #823. Both rows are Failed, and they are not the same event. The first
        // is a claim whose roster never armed: nothing left the building. The
        // second is a row the pre-#823 build stranded mid fan-out, and it is the
        // population the issue was filed about. Printing "never queued" over 61
        // sent copies is the confident wrong number.
        val base = MarketingBlastRow(
            id = "b3",
            key = "newsletter.announcement",
            title = "June",
            fireAtMs = 1L,
            status = BlastStatus.Failed,
            audienceDescription = "All active kinfolk",
            matched = 900,
            noLinkedAccount = 0,
            dispatched = 0,
            suppressed = 0,
            failed = 0,
        )
        assertTrue(blastMeta(base).contains("never queued"))

        val stranded = base.copy(id = "b4", dispatched = 61, suppressed = 4)
        val meta = blastMeta(stranded)
        assertTrue(meta.contains("61 sent, 4 suppressed, stopped part-way"))
        assertTrue(!meta.contains("never queued"))
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
