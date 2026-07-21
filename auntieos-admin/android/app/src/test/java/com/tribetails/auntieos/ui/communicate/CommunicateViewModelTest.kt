package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        coEvery { mockRepo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        // Comms-box reads are screen-driven (loadCommsBox), not triggered by
        // selectKinfolk, but stub sensible defaults so any flow that does reach them
        // never NPEs on a bare mock.
        coEvery { mockRepo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = CommunicateViewModel(repo = mockRepo)

    @Test
    fun `init loads kinfolk list`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        assertEquals(2, vm.uiState.value.kinfolkList.size)
        assertFalse(vm.uiState.value.kinfolkLoading)
    }

    @Test
    fun `init sets error when kinfolk load fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinfolk() } returns Result.failure(RuntimeException("Network error"))

        val vm = buildViewModel()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.kinfolkLoading)
    }

    @Test
    fun `setCommType updates commType in state`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.setCommType("follow_up")
        assertEquals("follow_up", vm.uiState.value.commType)
    }

    @Test
    fun `generate sets error when rawNotes is blank`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setRawNotes("")
        vm.generate()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isGenerating)
    }

    @Test
    fun `generate populates generatedCopy on success`() = runTest(testDispatcher) {
        val response = GenerateResponse(
            generatedCopy = "Great visit!",
            draftId = "d1",
            kinfolkId = "kf1",
            kinfolkName = "Rosa Parks",
            communicationType = "visit_report",
            model = "claude-3"
        )
        coEvery { mockRepo.generate(any()) } returns Result.success(response)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setCommType("blog_post") // recipient-less, so no recipient required
        vm.setRawNotes("Biscuit was great today")
        vm.generate()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals("Great visit!", state.generatedCopy)
        assertEquals("d1", state.draftId)
        assertFalse(state.isGenerating)
        assertNull(state.error)
    }

    @Test
    fun `generate sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.generate(any()) } returns Result.failure(RuntimeException("AI error"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setCommType("blog_post") // recipient-less, so generate reaches the AI call
        vm.setRawNotes("Some notes")
        vm.generate()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isGenerating)
    }

    @Test
    fun `approveDraft sets error when no draftId`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.approveDraft()

        assertNotNull(vm.uiState.value.error)
    }

    @Test
    fun `approveDraft sets savedDraftId on success`() = runTest(testDispatcher) {
        val response = GenerateResponse(
            generatedCopy = "Great!",
            draftId = "d1",
            kinfolkId = "kf1"
        )
        coEvery { mockRepo.generate(any()) } returns Result.success(response)
        coEvery { mockRepo.approveDraft(any(), any(), any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setCommType("blog_post") // recipient-less, so generate proceeds
        vm.setRawNotes("notes")
        vm.generate()
        advanceUntilIdle()

        vm.approveDraft()
        advanceUntilIdle()

        assertEquals("d1", vm.uiState.value.savedDraftId)
        assertNotNull(vm.uiState.value.successMessage)
    }

    @Test
    fun `approveDraft sets error on failure`() = runTest(testDispatcher) {
        val response = GenerateResponse(generatedCopy = "Great!", draftId = "d1", kinfolkId = "kf1")
        coEvery { mockRepo.generate(any()) } returns Result.success(response)
        coEvery { mockRepo.approveDraft(any(), any(), any()) } returns Result.failure(RuntimeException("Save failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setCommType("blog_post") // recipient-less, so generate proceeds
        vm.setRawNotes("notes")
        vm.generate()
        advanceUntilIdle()

        vm.approveDraft()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isSaving)
    }

    @Test
    fun `selectKinfolk sets selectedKinfolk and loads profiles`() = runTest(testDispatcher) {
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
        coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.selectKinfolk(TestFixtures.kinfolk1)
        advanceUntilIdle()

        assertEquals(TestFixtures.kinfolk1, vm.uiState.value.selectedKinfolk)
    }

    @Test
    fun `loadCommsBox with flag off loads raw-latest box without calling recap`() = runTest(testDispatcher) {
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
        coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.recentCommsForKinfolk(any()) } returns Result.success(
            RecentComms(
                sms = listOf(
                    SmsMessage(
                        id = "s1",
                        kinfolkId = "kf1",
                        timestamp = "2026-06-10T00:00:00Z",
                        body = "see you Tuesday",
                    ),
                ),
            ),
        )

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.selectKinfolk(TestFixtures.kinfolk1.copy(id = "kf1"))
        vm.loadCommsBox("kf1", recapFlagOn = false) // flag OFF -> recap callable not invoked
        advanceUntilIdle()

        val box = vm.uiState.value.commsBox
        assertTrue(box is CommsBoxState.RawLatest)
        assertNull(vm.uiState.value.commsRecapError)
        coVerify(exactly = 0) { mockRepo.recapRecentComms(any()) }
    }

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.generate()

        assertNotNull(vm.uiState.value.error)
        vm.clearError()
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `generate called twice while in-flight only invokes repo once`() {
        // Uses StandardTestDispatcher so coroutines are NOT auto-advanced, letting us
        // call generate() a second time while the first coroutine is still queued.
        val std = StandardTestDispatcher()
        Dispatchers.setMain(std)
        val localRepo: AuntieRepository = mockk()
        coEvery { localRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { localRepo.generate(any()) } returns Result.success(
            GenerateResponse(
                generatedCopy = "Hello",
                draftId = "d1",
                kinfolkId = "kf1",
                kinfolkName = "Rosa",
                communicationType = "visit_report",
                model = "claude-3"
            )
        )
        kotlinx.coroutines.test.TestScope(std).run {
            val vm = CommunicateViewModel(repo = localRepo)
            advanceUntilIdle()

            vm.setCommType("blog_post") // recipient-less, so generate proceeds
            vm.setRawNotes("Visited today, dogs were great")
            vm.generate()       // sets isGenerating=true synchronously, queues coroutine
            vm.generate()       // isGenerating is true -> should be ignored
            advanceUntilIdle()

            coVerify(exactly = 1) { localRepo.generate(any()) }
        }
        Dispatchers.setMain(testDispatcher)
    }

    // H-A3: synthesizeProfile with no kinfolk selected must set error - not silently return
    @Test
    fun `synthesizeProfile sets error when no kinfolk is selected`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        // No kinfolk selected - selectedKinfolk is null
        vm.synthesizeProfile()
        advanceUntilIdle()

        assertNotNull(
            "synthesizeProfile() must set an error when called with no kinfolk selected",
            vm.uiState.value.error
        )
        assertFalse(vm.uiState.value.isSynthesizing)
    }

    @Test
    fun `synthesizeProfile sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
        coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.synthesizeProfile(any()) } returns Result.failure(RuntimeException("Synth failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.selectKinfolk(TestFixtures.kinfolk1)
        advanceUntilIdle()

        vm.synthesizeProfile()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isSynthesizing)
    }

    @Test
    fun `synthesizeProfile sets successMessage on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
        coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.synthesizeProfile(any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.selectKinfolk(TestFixtures.kinfolk1)
        advanceUntilIdle()

        vm.synthesizeProfile()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isSynthesizing)
        assertEquals("Profile updated from recent history.", vm.uiState.value.successMessage)
        assertNull(vm.uiState.value.error)
    }

    // spec 19 item 2: recipient-needing types require a recipient before generate.
    @Test
    fun `generate sets error when recipient-needing type has no recipient`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.setCommType("visit_report") // needs a recipient
        vm.setRawNotes("Biscuit was great")
        vm.generate()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertEquals("", vm.uiState.value.generatedCopy)
    }

    @Test
    fun `needsRecipient is false only for blog and social`() {
        assertFalse(needsRecipient("blog_post"))
        assertFalse(needsRecipient("social_post"))
        assertTrue(needsRecipient("visit_report"))
        assertTrue(needsRecipient("email"))
        assertTrue(needsRecipient("sms"))
    }
}
