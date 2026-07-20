package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinTaleComment
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.web.screens.kintales.buildCommentThread
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/**
 * Unit + integration coverage for the KinTale comment thread: the VM's postComment
 * lifecycle (happy / blank / server-error) and the pure buildCommentThread grouping
 * helper. Backed by [FakeAuntieDataSource], which records the exact addKinTaleComment
 * payload and can fail loud.
 */
class KinTaleReportViewModelCommentTest {

    private fun dsAndVm(scope: kotlinx.coroutines.CoroutineScope): Pair<FakeAuntieDataSource, KinTaleReportViewModel> {
        val ds = FakeAuntieDataSource()
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = scope)
        return ds to vm
    }

    // ── postComment lifecycle ────────────────────────────────────────────────

    @Test
    fun `postComment happy clears draft and reply target`() = runTest {
        val (ds, vm) = dsAndVm(this)
        vm.updateCommentDraft("Such a good pup today!")
        vm.postComment(taleId = "tale-1", kinfolkId = "fam-1")
        advanceUntilIdle()
        assertEquals("", vm.commentDraft)
        assertNull(vm.replyTargetId)
        assertNull(vm.commentError)
        assertFalse(vm.isPostingComment)
        // The exact payload reached the data source.
        assertEquals(Triple("tale-1", "Such a good pup today!", null), ds.lastAddedComment)
    }

    @Test
    fun `postComment reply sends parentCommentId`() = runTest {
        val (ds, vm) = dsAndVm(this)
        vm.setReplyTarget("parent-c")
        vm.updateCommentDraft("Replying now")
        vm.postComment(taleId = "tale-1", kinfolkId = "fam-1")
        advanceUntilIdle()
        assertEquals(Triple("tale-1", "Replying now", "parent-c"), ds.lastAddedComment)
        assertNull(vm.replyTargetId)
    }

    @Test
    fun `postComment blank body sets error and writes nothing`() = runTest {
        val (ds, vm) = dsAndVm(this)
        vm.updateCommentDraft("   ")
        vm.postComment(taleId = "tale-1", kinfolkId = "fam-1")
        advanceUntilIdle()
        assertEquals("Write something first.", vm.commentError)
        assertNull(ds.lastAddedComment)
    }

    @Test
    fun `postComment server error surfaces fail-loud message`() = runTest {
        val (ds, vm) = dsAndVm(this)
        ds.addKinTaleCommentShouldFail = true
        vm.updateCommentDraft("hello")
        vm.postComment(taleId = "tale-1", kinfolkId = "fam-1")
        advanceUntilIdle()
        assertTrue(vm.commentError?.startsWith("Could not post: ") == true)
        assertTrue(vm.commentError?.contains("permission-denied") == true)
        assertFalse(vm.isPostingComment)
        // Draft is preserved so the auntie can retry.
        assertEquals("hello", vm.commentDraft)
    }

    @Test
    fun `updateCommentDraft clears a prior error`() = runTest {
        val (_, vm) = dsAndVm(this)
        vm.updateCommentDraft("")
        vm.postComment(taleId = "tale-1", kinfolkId = "fam-1")
        advanceUntilIdle()
        assertTrue(vm.commentError != null)
        vm.updateCommentDraft("typing again")
        assertNull(vm.commentError)
    }

    // ── integration: stream feeds rows, error yields fail-loud (no fabricated rows) ──

    @Test
    fun `commentsStream renders kinfolk admin and guest rows in order`() = runTest {
        val (ds, vm) = dsAndVm(this)
        ds.kinTaleComments.value = mapOf(
            "tale-1" to listOf(
                KinTaleComment(_id = "c1", authorRole = "kinfolk", body = "thank you", createdAtMs = 100),
                KinTaleComment(_id = "c2", authorRole = "admin", body = "you're welcome", parentCommentId = "c1", createdAtMs = 200),
                KinTaleComment(_id = "c3", authorRole = "guest", guestName = "Pat", body = "aww", createdAtMs = 300),
            ),
        )
        val result = vm.commentsStream("tale-1", "fam-1").first()
        assertTrue(result is FirestoreResult.Data)
        val rows = buildCommentThread((result as FirestoreResult.Data).value)
        assertEquals(listOf("c1", "c2", "c3"), rows.map { it.comment._id })
        assertEquals(listOf(false, true, false), rows.map { it.isReply })
    }

    @Test
    fun `commentsStream error yields fail-loud Error not empty data`() = runTest {
        val (ds, vm) = dsAndVm(this)
        ds.commentsStreamError = "listener denied"
        val result = vm.commentsStream("tale-1", "fam-1").first()
        assertTrue(result is FirestoreResult.Error)
        assertEquals("listener denied", (result as FirestoreResult.Error).message)
    }

    // ── pure tree builder ────────────────────────────────────────────────────

    @Test
    fun `buildCommentThread groups replies one level under chronological parents`() {
        val flat = listOf(
            KinTaleComment(_id = "p2", parentCommentId = null, createdAtMs = 50),
            KinTaleComment(_id = "p1", parentCommentId = null, createdAtMs = 10),
            KinTaleComment(_id = "r1b", parentCommentId = "p1", createdAtMs = 40),
            KinTaleComment(_id = "r1a", parentCommentId = "p1", createdAtMs = 20),
        )
        val rows = buildCommentThread(flat)
        // p1 (10) first with its replies r1a (20), r1b (40), then p2 (50).
        assertEquals(listOf("p1", "r1a", "r1b", "p2"), rows.map { it.comment._id })
        assertEquals(listOf(false, true, true, false), rows.map { it.isReply })
    }

    @Test
    fun `buildCommentThread surfaces orphan replies as top-level rows`() {
        val flat = listOf(
            KinTaleComment(_id = "p1", parentCommentId = null, createdAtMs = 10),
            KinTaleComment(_id = "orphan", parentCommentId = "missing", createdAtMs = 20),
        )
        val rows = buildCommentThread(flat)
        // Orphan reply is not silently dropped; it renders as its own top-level row.
        assertTrue(rows.any { it.comment._id == "orphan" && !it.isReply })
        assertEquals(2, rows.size)
    }
}
