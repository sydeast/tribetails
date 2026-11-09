package com.tribetails.auntieos.ui.kintales

import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.data.model.ChecklistBankItem
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1593 (QA walk 2026-11-05): "KinTale templates: an empty checklist item saves."
 *
 * The checklist editor saves on blur, on Back and on Save Changes. Each of those
 * used to write whatever the list held, blank items included. Now a write that
 * carries the checklist with a blank item (or more than 60) is refused before it
 * is sent; `persist` answers false so Back and Save Changes keep the operator on
 * the screen with their typing, and the explicit presses show every blank item's
 * message. The screen's Back and Save Changes are `if (persist(reveal = true)) onBack()`,
 * so the false answer here is what keeps the operator on the screen.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleTemplateChecklistSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    private fun stored(items: List<ChecklistItem> = listOf(ChecklistItem(key = "fed", text = "Fed", order = 0))) =
        KinTaleTemplate(
            id = "tmpl-1",
            name = "Daily Walk Recap",
            checklistItems = items,
            createdAt = "2026-01-01T00:00:00",
            updatedAt = "2026-08-01T00:00:00",
        )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(stored()))
        coEvery { repo.updateKinTaleTemplateFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.createKinTaleTemplate(any()) } returns Result.success("tmpl-new")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun editor(templateId: String = "tmpl-1") =
        KinTaleTemplateEditorViewModel(repository = repo).also { it.load(templateId) }

    private fun newItem(vm: KinTaleTemplateEditorViewModel): ChecklistItem =
        vm.uiState.value.template.checklistItems.last()

    private fun capturedChanges(): Map<String, Any?> {
        val changes = mutableListOf<Map<String, Any?>>()
        coVerify { repo.updateKinTaleTemplateFields(any(), capture(changes)) }
        return changes.last()
    }

    @Test
    fun `a blur save with a fresh blank item writes nothing and says nothing yet`() = runTest(testDispatcher) {
        val vm = editor()
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_PET)

        assertFalse(vm.persist())
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
        assertEquals(emptySet<String>(), vm.uiState.value.flaggedChecklistIds)
        // Save Changes stays on: nothing on screen would say why it was off.
        assertNull(vm.uiState.value.saveBlockedReason)
    }

    @Test
    fun `Back or Save Changes with a blank item stays put, writes nothing, and says why`() = runTest(testDispatcher) {
        val vm = editor()
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_PET)
        val blank = newItem(vm)

        assertFalse(vm.persist(reveal = true))
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
        assertEquals(setOf(checklistItemId(blank)), vm.uiState.value.flaggedChecklistIds)
        assertEquals(CHECKLIST_ITEM_BLANK, vm.uiState.value.saveBlockedReason)
        // Nothing the operator typed or added was dropped.
        assertEquals(2, vm.uiState.value.template.checklistItems.size)
    }

    @Test
    fun `leaving a blank item flags it`() = runTest(testDispatcher) {
        val vm = editor()
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_VISIT)
        val blank = newItem(vm)

        vm.leaveChecklistItem(blank)

        assertEquals(setOf(checklistItemId(blank)), vm.uiState.value.flaggedChecklistIds)
        assertEquals(CHECKLIST_ITEM_BLANK, vm.uiState.value.saveBlockedReason)
    }

    @Test
    fun `spaces alone are blank`() = runTest(testDispatcher) {
        val vm = editor()
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_PET)
        vm.updateChecklistItem(newItem(vm).copy(text = "   "))

        assertFalse(vm.persist(reveal = true))
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
    }

    @Test
    fun `once the item has text the save goes through, written trimmed`() = runTest(testDispatcher) {
        val vm = editor()
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_PET)
        vm.updateChecklistItem(newItem(vm).copy(text = "  Walked "))

        assertTrue(vm.persist(reveal = true))
        advanceUntilIdle()

        @Suppress("UNCHECKED_CAST")
        val written = capturedChanges()["checklistItems"] as List<ChecklistItem>
        assertEquals(listOf("Fed", "Walked"), written.map { it.text })
        assertEquals(emptySet<String>(), vm.uiState.value.flaggedChecklistIds)
    }

    @Test
    fun `a stored blank item does not stop an edit that leaves the checklist alone`() = runTest(testDispatcher) {
        // The server only checks a write that carries the checklist, so an old
        // template with a blank item can still be renamed from the main editor.
        coEvery { repo.getKinTaleTemplates() } returns Result.success(
            listOf(stored(listOf(ChecklistItem(key = "old", text = "", order = 0)))),
        )
        val vm = editor()
        advanceUntilIdle()
        vm.updateName("Morning Walk Recap")

        assertTrue(vm.persist(reveal = true))
        advanceUntilIdle()

        assertEquals(setOf("name"), capturedChanges().keys)
    }

    @Test
    fun `a stored blank item is flagged at once, and blocks a checklist edit`() = runTest(testDispatcher) {
        coEvery { repo.getKinTaleTemplates() } returns Result.success(
            listOf(stored(listOf(ChecklistItem(key = "fed", text = "Fed", order = 0), ChecklistItem(key = "old", text = " ", order = 1)))),
        )
        val vm = editor()
        advanceUntilIdle()
        assertEquals(setOf("PER_PET:old"), vm.uiState.value.flaggedChecklistIds)

        vm.updateChecklistItem(ChecklistItem(key = "fed", text = "Fed breakfast", order = 0))
        assertFalse(vm.persist(reveal = true))
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
    }

    @Test
    fun `a new template with a blank item is not created`() = runTest(testDispatcher) {
        val vm = editor(templateId = "new")
        advanceUntilIdle()
        vm.addChecklistItem(ChecklistScope.PER_PET)

        assertFalse(vm.persist(reveal = true))
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.createKinTaleTemplate(any()) }
    }

    @Test
    fun `at 60 items Add item and Add from bank do nothing`() = runTest(testDispatcher) {
        val sixty = List(60) { i -> ChecklistItem(key = "k$i", text = "Item $i", order = i) }
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(stored(sixty)))
        val vm = editor()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.checklistHasRoom)

        vm.addChecklistItem(ChecklistScope.PER_VISIT)
        vm.addFromBank(ChecklistBankItem(id = "water", text = "Fresh water", scope = "PER_PET"))

        assertEquals(60, vm.uiState.value.template.checklistItems.size)
    }

    @Test
    fun `a stored checklist over 60 cannot be saved once it is edited`() = runTest(testDispatcher) {
        val over = List(61) { i -> ChecklistItem(key = "k$i", text = "Item $i", order = i) }
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(stored(over)))
        val vm = editor()
        advanceUntilIdle()
        assertEquals(CHECKLIST_LIMIT_REACHED, vm.uiState.value.saveBlockedReason)

        vm.updateChecklistItem(over[0].copy(text = "Renamed"))
        assertFalse(vm.persist(reveal = true))
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.updateKinTaleTemplateFields(any(), any()) }
    }

    @Test
    fun `a rules refusal shows a sentence, not PERMISSION_DENIED`() = runTest(testDispatcher) {
        coEvery { repo.updateKinTaleTemplateFields(any(), any()) } returns Result.failure(
            FirebaseFirestoreException(
                "PERMISSION_DENIED: Missing or insufficient permissions.",
                FirebaseFirestoreException.Code.PERMISSION_DENIED,
            ),
        )
        val vm = editor()
        advanceUntilIdle()
        vm.updateChecklistItem(ChecklistItem(key = "fed", text = "Fed breakfast", order = 0))

        vm.persist(reveal = true)
        advanceUntilIdle()

        assertEquals(TEMPLATE_SAVE_REFUSED, vm.uiState.value.error)
    }
}
