package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.CommentsState
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.KinTaleComment
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Comment-thread unit tests for [KinTaleReportViewModel] (spec 11 item 6.2),
 * mirroring the web KinTaleReportViewModelCommentTest. A mocked
 * [KinTaleCommentsRepository] records the exact addKinTaleComment payload and feeds
 * deterministic stream states.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleReportViewModelCommentTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockKinCareRepo: KinCareRepository
    private lateinit var mockComments: KinTaleCommentsRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk(relaxed = true)
        mockKinCareRepo = mockk(relaxed = true)
        mockComments = mockk(relaxed = true)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun vm() = KinTaleReportViewModel(
        repository = mockRepo,
        kinCareRepository = mockKinCareRepo,
        mediaUploader = mockk<MediaUploadManager>(relaxed = true),
        notifier = mockk<VisitNotifier>(relaxed = true),
        commentsRepo = mockComments,
    )

    @Test
    fun `observeComments wires stream Data into state`() = runTest(testDispatcher) {
        coEvery { mockComments.streamComments("t1") } returns flowOf(
            CommentsState.Data(
                listOf(
                    KinTaleComment(id = "c1", authorRole = "kinfolk", body = "hi", createdAtMs = 1),
                    KinTaleComment(id = "c2", authorRole = "admin", body = "hello back", parentCommentId = "c1", createdAtMs = 2),
                ),
            ),
        )
        val vm = vm()
        vm.observeComments("t1")
        advanceUntilIdle()
        val s = vm.uiState.value.comments
        assertTrue(s is CommentsState.Data)
        assertEquals(2, (s as CommentsState.Data).comments.size)
    }

    @Test
    fun `observeComments surfaces Error state fail-loud`() = runTest(testDispatcher) {
        coEvery { mockComments.streamComments("t1") } returns flowOf(CommentsState.Error("permission-denied"))
        val vm = vm()
        vm.observeComments("t1")
        advanceUntilIdle()
        val s = vm.uiState.value.comments
        assertTrue(s is CommentsState.Error)
        assertEquals("permission-denied", (s as CommentsState.Error).message)
    }

    @Test
    fun `postComment HAPPY clears draft and reply target and sends correct payload`() = runTest(testDispatcher) {
        val taleSlot = slot<String>()
        val kinfolkSlot = slot<String>()
        val bodySlot = slot<String>()
        val parentSlot = slot<String?>()
        coEvery {
            mockComments.addComment(capture(taleSlot), capture(kinfolkSlot), capture(bodySlot), captureNullable(parentSlot))
        } returns Result.success("new-id")

        val vm = vm()
        vm.setReplyTarget("parentC")
        vm.updateCommentDraft("  a reply  ")
        vm.postComment("t1", "f1")
        advanceUntilIdle()

        assertEquals("t1", taleSlot.captured)
        assertEquals("f1", kinfolkSlot.captured)
        assertEquals("a reply", bodySlot.captured)
        assertEquals("parentC", parentSlot.captured)
        // Draft + reply target cleared, no error.
        assertEquals("", vm.uiState.value.commentDraft)
        assertNull(vm.uiState.value.replyTargetId)
        assertNull(vm.uiState.value.commentError)
        assertEquals(false, vm.uiState.value.isPostingComment)
    }

    @Test
    fun `postComment SAD blank body sets error and never calls addComment`() = runTest(testDispatcher) {
        val vm = vm()
        vm.updateCommentDraft("   ")
        vm.postComment("t1", "f1")
        advanceUntilIdle()

        assertEquals("Write something first.", vm.uiState.value.commentError)
        coVerify(exactly = 0) { mockComments.addComment(any(), any(), any(), any()) }
    }

    @Test
    fun `postComment ERROR maps failure to commentError`() = runTest(testDispatcher) {
        coEvery { mockComments.addComment(any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("permission-denied"))
        val vm = vm()
        vm.updateCommentDraft("nope")
        vm.postComment("t1", "f1")
        advanceUntilIdle()

        assertTrue(vm.uiState.value.commentError!!.startsWith("Could not post: "))
        assertEquals(false, vm.uiState.value.isPostingComment)
    }

    @Test
    fun `postComment SAD missing kinfolk sets error without calling addComment`() = runTest(testDispatcher) {
        val vm = vm()
        vm.updateCommentDraft("hi")
        vm.postComment("t1", "")
        advanceUntilIdle()

        assertTrue(vm.uiState.value.commentError!!.contains("kinfolk"))
        coVerify(exactly = 0) { mockComments.addComment(any(), any(), any(), any()) }
    }
}
