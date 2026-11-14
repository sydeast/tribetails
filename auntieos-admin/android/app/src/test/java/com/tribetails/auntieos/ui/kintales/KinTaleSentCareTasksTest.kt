package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.CareTaskCopy
import com.tribetails.auntieos.data.model.CareTaskDone
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.FieldResponse
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.model.forKinTale
import com.tribetails.auntieos.data.model.kinCareReportFieldChanges
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
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
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

/**
 * #2058, operator ruling 2026-11-12 (stamp at send): a SENT KinTale is shown
 * against its own copy of the care tasks, so a template deleted for good or
 * edited after the send never changes it. A draft still follows its template.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleSentCareTasksTest {

    private val copy = CareTaskCopy(
        v = 1,
        stampedAt = "2026-06-02T11:00:00Z",
        stampedBy = "send",
        templateId = "tpl-walk",
        templateName = "Dog Walk",
        source = "template",
        checklistEnabled = true,
        items = listOf(
            ChecklistItem(key = "moment_walk", text = "Long walk in the park", scope = "PER_PET", order = 0),
            ChecklistItem(key = "moment_mail", text = "Brought the mail in", scope = "PER_VISIT", order = 1),
        ),
        done = listOf(CareTaskDone(key = "moment_walk", kinId = "kin1", text = "Long walk in the park")),
    )

    private val sentTale = KinCareReport(
        id = "rep-sent",
        sessionId = "ses1",
        kinfolkId = "kf1",
        templateId = "tpl-walk",
        bodyCopy = "Biscuit found a stick.",
        status = ReportStatus.SENT.name,
        sentAt = "2026-06-02T11:00:00Z",
        sentVia = "catalog",
        fieldResponses = mapOf(
            "kin1|moment_walk" to FieldResponse(fieldKey = "moment_walk", kinId = "kin1", boolValue = true),
        ),
        careTasks = copy,
    )

    /** What the service type resolves to NOW: renamed after the send. */
    private val templateNow = KinTaleTemplate(
        id = "tpl-walk",
        name = "Dog Walk",
        checklistItems = listOf(ChecklistItem(key = "moment_walk", text = "Renamed later", order = 0)),
    )

    @Test
    fun `a sent tale is shown against its own copy, not the template as it stands now`() {
        val shown = templateNow.forKinTale(sentTale)
        assertEquals(listOf("Long walk in the park", "Brought the mail in"), shown.checklistItems.map { it.text })
        assertEquals("PER_VISIT", shown.checklistItems[1].scope)
    }

    @Test
    fun `the copy survives the template being deleted for good`() {
        val builtIn = KinTaleTemplate(id = "__default__", name = "Standard Visit")
        val shown = builtIn.forKinTale(sentTale)
        assertEquals("Dog Walk", shown.name)
        assertEquals(listOf("moment_walk", "moment_mail"), shown.checklistItems.map { it.key })
    }

    @Test
    fun `a draft still follows its template`() {
        val draft = sentTale.copy(status = ReportStatus.DRAFT.name, sentAt = "")
        assertSame(templateNow, templateNow.forKinTale(draft))
    }

    @Test
    fun `a tale sent before the copy existed, or with a copy this app does not know, follows its template`() {
        assertSame(templateNow, templateNow.forKinTale(sentTale.copy(careTasks = null)))
        assertSame(templateNow, templateNow.forKinTale(sentTale.copy(careTasks = copy.copy(v = 2))))
    }

    @Test
    fun `no save from this app ever writes the copy back`() {
        val edited = sentTale.copy(
            careTasks = copy.copy(done = emptyList()),
            fieldResponses = sentTale.fieldResponses +
                ("moment_mail" to FieldResponse(fieldKey = "moment_mail", kinId = "", boolValue = true)),
        )
        val changes = kinCareReportFieldChanges(sentTale, edited)
        assertEquals(setOf("fieldResponses"), changes.keys)
        assertFalse(changes.containsKey("careTasks"))
    }

    // ── through the screen's view model ──────────────────────────────────────

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        kinCareRepo = mockk()
        coEvery { kinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { repo.getKinfolkById(any()) } returns Result.success(TestFixtures.kinfolk1)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(templateNow)
        coEvery { repo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getReportsForVisit(any()) } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareReport("rep-sent") } returns Result.success(sentTale)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = KinTaleReportViewModel(
        repository = repo,
        kinCareRepository = kinCareRepo,
        mediaUploader = mockk<MediaUploadManager>(relaxed = true),
        notifier = mockk<VisitNotifier>(relaxed = true),
    )

    @Test
    fun `opening a sent tale shows the tasks it was sent with`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.load("ses1", "rep-sent")
        advanceUntilIdle()
        assertEquals(
            listOf("Long walk in the park", "Brought the mail in"),
            vm.uiState.value.template.checklistItems.map { it.text },
        )
    }

    @Test
    fun `a tick changed on the sent tale saves only the answers`() = runTest(testDispatcher) {
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields("rep-sent", capture(changes)) } returns Result.success(Unit)
        val vm = buildViewModel()
        vm.load("ses1", "rep-sent")
        advanceUntilIdle()
        vm.setChecklistResponse("moment_mail", "", true)
        vm.saveChanges()
        advanceUntilIdle()
        assertEquals(setOf("fieldResponses"), changes.captured.keys)
    }
}
