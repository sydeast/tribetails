package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The editor half of the `kintale_templates` fix: WHAT the phone asks the
 * repository to write.
 *
 * `KinTaleTemplateMergeTest` proves merge preserves the field this client cannot
 * name. This proves the other half - that a section toggle asks for the section
 * toggle, and not for the whole template the phone happened to load. Both are
 * needed: merge alone still reverts a sibling's edit to a field this model DOES
 * declare, and `getMyKinTales` reads `checklistItems` server-side to label the
 * rows a kinfolk sees.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleTemplateEditorViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    private val stored = KinTaleTemplate(
        id = "tmpl-1",
        name = "Daily Walk Recap",
        description = "The standard dog-walk recap",
        isDefault = false,
        checklistItems = listOf(
            ChecklistItem(key = "fed", text = "Fed", order = 0),
            ChecklistItem(key = "meds_given", text = "Medications given", order = 1),
        ),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-08-01T00:00:00",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(stored))
        coEvery { repo.updateKinTaleTemplateFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.createKinTaleTemplate(any()) } returns Result.success("tmpl-new")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun loadedEditor(templateId: String = "tmpl-1") =
        KinTaleTemplateEditorViewModel(repository = repo).also { it.load(templateId) }

    /**
     * The field map the editor last handed the repository. Captured into a list
     * rather than a slot because more than one save per test is the point of
     * several of these.
     */
    private fun capturedChanges(): Map<String, Any?> {
        val changes = mutableListOf<Map<String, Any?>>()
        coVerify { repo.updateKinTaleTemplateFields(any(), capture(changes)) }
        return changes.last()
    }

    // ── the defect ────────────────────────────────────────────────────────────

    @Test
    fun `toggling a section asks for that section and nothing else`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.togglePetMood(false)
        vm.persist()
        advanceUntilIdle()

        assertEquals(setOf("petMoodEnabled"), capturedChanges().keys)
    }

    /**
     * The rows a kinfolk sees. `getMyKinTales.parseTemplateChecklistItems`
     * resolves a checked key's label from THIS list and drops a key it cannot
     * find, so writing back a stale copy does not merely look wrong in the
     * editor - it deletes a row from the family's recap.
     */
    @Test
    fun `renaming the template does not resend the checklist`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.updateName("Morning Walk Recap")
        vm.persist()
        advanceUntilIdle()

        assertEquals(setOf("name"), capturedChanges().keys)
    }

    @Test
    fun `a checklist edit does ask for the checklist`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.updateChecklistItem(ChecklistItem(key = "fed", text = "Fed breakfast", order = 0))
        vm.persist()
        advanceUntilIdle()

        assertEquals(setOf("checklistItems"), capturedChanges().keys)
    }

    /**
     * `persist` fires on blur, so a second save straight after the first is the
     * normal case. Without advancing the baseline, that second save would resend
     * everything the first one just wrote - reopening the reversion on every
     * field the operator had already saved.
     */
    @Test
    fun `a second save asks only for what changed since the first`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.updateName("Morning Walk Recap")
        vm.persist()
        advanceUntilIdle()

        vm.updateDescription("Now with breakfast")
        vm.persist()
        advanceUntilIdle()

        assertEquals(setOf("description"), capturedChanges().keys)
    }

    @Test
    fun `a save that changed nothing writes nothing and still reports saved`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.persist()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
    }

    /** Clearing a field IS an edit, and must not be swallowed by the diff. */
    @Test
    fun `a cleared description is still asked for`() = runTest(testDispatcher) {
        val vm = loadedEditor()
        advanceUntilIdle()

        vm.updateDescription("")
        vm.persist()
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("description" to ""), capturedChanges())
    }

    // ── the sibling demotion ──────────────────────────────────────────────────

    /**
     * The sibling the operator never opened. One boolean, exactly as the React
     * admin's `batch.update(ref, { isDefault: false })` does it.
     */
    @Test
    fun `demoting another default asks only for the flag`() = runTest(testDispatcher) {
        val other = stored.copy(id = "tmpl-2", name = "Overnight Recap", isDefault = true)
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(stored, other))

        val vm = loadedEditor()
        advanceUntilIdle()

        vm.toggleIsDefault(true)
        vm.persist()
        advanceUntilIdle()

        coVerify { repo.updateKinTaleTemplateFields("tmpl-2", mapOf("isDefault" to false)) }
    }

    // ── the refusals ──────────────────────────────────────────────────────────

    /**
     * A template id the collection no longer holds used to decode to a blank
     * `KinTaleTemplate()`, which a save then wrote over the real document -
     * blanking every field on it. There is no baseline, so there is no honest
     * write.
     */
    @Test
    fun `an unknown template id is refused rather than saved as a blank template`() = runTest(testDispatcher) {
        val vm = loadedEditor(templateId = "tmpl-gone")
        advanceUntilIdle()

        vm.updateName("Anything")
        vm.persist()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        assertNotNull(vm.uiState.value.error)
        assertTrue(vm.uiState.value.error!!.contains("no longer loaded"))
    }

    // ── the case where a whole-document write IS correct ──────────────────────

    @Test
    fun `a brand-new template is created whole and becomes its own baseline`() = runTest(testDispatcher) {
        val vm = KinTaleTemplateEditorViewModel(repository = repo).also { it.load("new") }
        advanceUntilIdle()

        vm.updateName("Cat Sit Recap")
        vm.persist()
        advanceUntilIdle()

        coVerify { repo.createKinTaleTemplate(any()) }
        assertEquals("tmpl-new", vm.uiState.value.template.id)

        // The save straight after a create must diff against what was created,
        // not resend it.
        vm.updateDescription("For the cat rounds")
        vm.persist()
        advanceUntilIdle()

        assertEquals(setOf("description"), capturedChanges().keys)
    }

    /**
     * Mark 23 of the 2026-08-17 walk: the message is the story of the visit, so
     * a canned line here invited sending it unedited. Matches the web port's
     * `newTemplateDraft`/`seedTemplateDraft`, which now get the same blank from
     * `DEFAULT_KINTALE_TEMPLATE.defaultEmailMessage`.
     */
    @Test
    fun `a brand-new template scaffold carries no default message`() = runTest(testDispatcher) {
        val vm = KinTaleTemplateEditorViewModel(repository = repo).also { it.load("new") }
        advanceUntilIdle()

        assertEquals("", vm.uiState.value.template.defaultEmailMessage)
    }
}
