package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #867 re-review: a broadcast still sending is found and put back on the form with its own key. */
class BroadcastDraftSessionTest {

    @AfterTest
    fun tearDown() = BroadcastDraftSession.clear()

    private val now = 1_800_000_000_000L

    private fun row(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun running(id: String = "key-1", sentAtMs: Long = now - 60_000, state: String = "running", extra: String = "") = row(
        """{"_id":"$id","fanoutState":"$state","sentAtMs":$sentAtMs,"subject":"Walks","body":"Walks are back on Monday.",
           "channels":["sms","email"],"segmentId":null,"criteria":{"kind":"tags","tags":["VIP"],"tagMatch":"all"}$extra}""",
    )

    @Test
    fun onlyRecentRunningRowsWithABodyAndAKnownChannelCount() {
        val rows = listOf(
            running(id = "old", sentAtMs = now - RUNNING_BROADCAST_WINDOW_MS - 1),
            running(id = "done", state = "complete"),
            running(id = "newer", sentAtMs = now - 10_000),
            running(id = "older", sentAtMs = now - 120_000),
            row("""{"_id":"nobody","fanoutState":"running","sentAtMs":${now - 5_000},"channels":["sms"]}"""),
            row("""{"_id":"nochannel","fanoutState":"running","sentAtMs":${now - 5_000},"body":"x","channels":["fax"]}"""),
        )
        val found = decodeRunningBroadcasts(rows, now)
        assertEquals(listOf("newer", "older"), found.map { it.id })
        val first = found.first()
        assertEquals("Walks", first.subject)
        assertEquals(listOf(BroadcastChannel.Sms, BroadcastChannel.Email), first.channels)
        assertEquals(BroadcastCriteria(kind = SegmentKind.Tags, tags = listOf("VIP"), tagMatch = TagMatch.All), first.criteria)
        assertNull(first.segmentId)
    }

    @Test
    fun restoringARunningRowKeepsItsKeyForAnUnchangedSend() {
        val draft = BroadcastDraft()
        val found = decodeRunningBroadcasts(listOf(running()), now).single()
        draft.restoreRunning(found)

        assertEquals("key-1", draft.submissionKey)
        assertEquals("Walks are back on Monday.", draft.body)
        assertEquals("Walks", draft.subject)
        assertEquals(listOf(BroadcastChannel.Sms, BroadcastChannel.Email), draft.channels.toList())
        assertEquals(SegmentKind.Tags, draft.kind)
        // The restored draft IS the submission, so an unchanged Send reuses the key.
        assertEquals(draft.signature(), draft.submissionSignature)
        assertEquals(draft.signature(), draft.timedOutSignature)
        assertTrue(draft.errorIsTimeout)
        assertEquals("\"Walks\" may still be sending. Press Send again without changing anything to see its status.", draft.errorText)

        // An edit leaves the key where it was but makes the draft a new submission.
        draft.body = "Walks are back on Tuesday."
        assertTrue(broadcastEditWarning(draft.timedOutSignature, draft.signature()) != null)
    }

    @Test
    fun theSessionDraftSurvivesUntilCleared() {
        val draft = BroadcastDraftSession.current
        draft.submissionKey = "k"
        assertEquals("k", BroadcastDraftSession.current.submissionKey)
        BroadcastDraftSession.clear()
        assertNotSame(draft, BroadcastDraftSession.current)
        assertNull(BroadcastDraftSession.current.submissionKey)
    }

    @Test
    fun theNoticeNamesTheSubjectWhenThereIsOne() {
        assertTrue(runningBroadcastNotice("Walks").startsWith("\"Walks\" may still be sending."))
        assertTrue(runningBroadcastNotice(null).startsWith("Your last broadcast may still be sending."))
    }
}
