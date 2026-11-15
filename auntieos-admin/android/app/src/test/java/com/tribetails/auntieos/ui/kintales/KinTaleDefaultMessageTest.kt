package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #2050: a KinTale template's "Default message to kinfolk" never reached the
 * composer or the sent KinTale.
 *
 * It opens the message once, when a new tale is started, is the Auntie's to
 * change, and goes out as the tale's own message. It is not a change she made,
 * so opening the composer and leaving writes no draft.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleDefaultMessageTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockKinCareRepo: KinCareRepository
    private lateinit var mockNotifier: VisitNotifier

    private val message = "Thanks for having us today!"
    private val walkTemplate = KinTaleTemplate(id = "tpl_walk", name = "Dog Walk recap", defaultEmailMessage = message)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockKinCareRepo = mockk()
        mockNotifier = mockk(relaxed = true)
        coEvery { mockKinCareRepo.getReportsForVisit(any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockRepo.isCurrentUserOwner() } returns Result.success(true)
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.success("rep-1")
        coEvery { mockKinCareRepo.updateKinCareReportFields(any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.markReportSent(any(), any(), any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun templateIs(template: KinTaleTemplate?) {
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(template)
    }

    private fun buildViewModel() = KinTaleReportViewModel(
        repository = mockRepo,
        kinCareRepository = mockKinCareRepo,
        mediaUploader = mockk<MediaUploadManager>(relaxed = true),
        notifier = mockNotifier,
    )

    @Test
    fun `a new tale opens with the template's default message`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        assertEquals(message, vm.uiState.value.report.bodyCopy)
        assertEquals("", vm.uiState.value.report.title)
        assertEquals("tpl_walk", vm.uiState.value.report.templateId)
    }

    @Test
    fun `no template, a blank message and a message of spaces all open an empty note`() = runTest(testDispatcher) {
        for (template in listOf(null, walkTemplate.copy(defaultEmailMessage = ""), walkTemplate.copy(defaultEmailMessage = "  \n "))) {
            templateIs(template)
            val vm = buildViewModel()
            vm.load("ses1", null)
            advanceUntilIdle()
            assertEquals("", vm.uiState.value.report.bodyCopy)
        }
    }

    @Test
    fun `opening and leaving writes no draft and shows nothing unsaved`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        assertFalse(vm.uiState.value.hasUnsavedChanges)
        // What the screen calls on Back and on blur.
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 0) { mockKinCareRepo.createKinCareReport(any()) }
        assertEquals(SaveStatus.IDLE, vm.uiState.value.saveStatus)
    }

    @Test
    fun `Save Draft pressed on the untouched tale saves it, default message and all`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val created = slot<KinCareReport>()
        coEvery { mockKinCareRepo.createKinCareReport(capture(created)) } returns Result.success("rep-1")
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.persistDraft(asked = true)
        advanceUntilIdle()

        assertEquals(message, created.captured.bodyCopy)
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
        assertFalse(vm.uiState.value.hasUnsavedChanges)
    }

    @Test
    fun `the Auntie's first change saves the tale, default message and all`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val created = slot<KinCareReport>()
        coEvery { mockKinCareRepo.createKinCareReport(capture(created)) } returns Result.success("rep-1")
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Park day")
        assertTrue(vm.uiState.value.hasUnsavedChanges)
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals("Park day", created.captured.title)
        assertEquals(message, created.captured.bodyCopy)
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
    }

    @Test
    fun `what the Auntie types replaces the default message and is what is saved`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val created = slot<KinCareReport>()
        coEvery { mockKinCareRepo.createKinCareReport(capture(created)) } returns Result.success("rep-1")
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit found a stick.")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals("Biscuit found a stick.", created.captured.bodyCopy)
        assertEquals("Biscuit found a stick.", vm.uiState.value.report.bodyCopy)
    }

    @Test
    fun `a saved draft reopens with its own words, never the default message`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val saved = KinCareReport(
            id = "rep-9",
            sessionId = "ses1",
            kinfolkId = "kf1",
            templateId = "tpl_walk",
            title = "Park day",
            bodyCopy = "",
            status = ReportStatus.DRAFT.name,
        )
        coEvery { mockKinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(saved))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        // She emptied the message before saving; it stays empty.
        assertEquals("", vm.uiState.value.report.bodyCopy)
        assertEquals("Park day", vm.uiState.value.report.title)
    }

    @Test
    fun `sent untouched, the default message is saved as the tale's message and the tale is sent`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        val created = slot<KinCareReport>()
        coEvery { mockKinCareRepo.createKinCareReport(capture(created)) } returns Result.success("rep-1")
        coEvery { mockNotifier.notify(VisitNotifier.Event.REPORT_SENT, any(), any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(dispatchIds = listOf("d-1"), suppressed = false))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.send()
        advanceUntilIdle()

        assertEquals(message, created.captured.bodyCopy)
        assertTrue(vm.uiState.value.sentSuccessfully)
        coVerify(exactly = 1) { mockKinCareRepo.markReportSent("rep-1", any(), any(), any()) }
    }

    @Test
    fun `a save the server refuses keeps the message and says so`() = runTest(testDispatcher) {
        templateIs(walkTemplate)
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.failure(RuntimeException("offline"))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Park day")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        assertEquals(message, vm.uiState.value.report.bodyCopy)
    }

    @Test
    fun `a default message with markup in it is kept as the text it is`() {
        val markup = "Hi <img src=x onerror=alert(1)> <b>there</b>"
        assertEquals(markup, walkTemplate.copy(defaultEmailMessage = markup).defaultMessageForNewTale())
    }
}
