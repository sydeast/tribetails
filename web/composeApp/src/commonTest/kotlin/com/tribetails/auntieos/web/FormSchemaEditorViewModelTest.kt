package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.FormSectionSpec
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.admin.formschemas.FormSchemaEditorViewModel
import com.tribetails.auntieos.web.screens.admin.formschemas.SaveStatus
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

private class FakeFormSchemaRepository(
    var saved: MutableMap<String, FormSchema> = mutableMapOf(),
    var nextGetResult: WriteResult<FormSchema>? = null,
    var nextSaveResult: WriteResult<FormSchema>? = null,
    var nextDeleteResult: WriteResult<Unit>? = null,
) : FormSchemaRepository {

    var deletedIds: MutableList<String> = mutableListOf()
    var saveCalls: MutableList<FormSchema> = mutableListOf()

    override suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>> =
        WriteResult.Ok(saved.values.map { FormSchemaSummary(id = it.id, name = it.name, appliesTo = it.appliesTo, version = it.version, updatedAt = it.updatedAt, updatedBy = it.updatedBy) })

    override suspend fun getSchema(id: String): WriteResult<FormSchema> =
        nextGetResult ?: (saved[id]?.let { WriteResult.Ok(it) } ?: WriteResult.Err("not found"))

    override suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema> {
        saveCalls += schema
        nextSaveResult?.let { return it }
        val stored = schema.copy(version = schema.version + 1)
        saved[stored.id] = stored
        return WriteResult.Ok(stored)
    }

    override suspend fun deleteSchema(id: String): WriteResult<Unit> {
        deletedIds += id
        nextDeleteResult?.let { return it }
        saved.remove(id)
        return WriteResult.Ok(Unit)
    }
}

class FormSchemaEditorViewModelTest {

    private fun seedSchema() = FormSchema(
        id = "tribeProfile",
        name = "Tribe Profile",
        sections = listOf(
            FormSectionSpec(
                title = "About",
                fields = listOf(FormFieldSpec(key = "familyName", label = "Family name", type = "text", required = true)),
            ),
        ),
        version = 3,
    )

    // ---- load → edit → save success ----

    @Test
    fun loadEditSave_success_flow() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        val vm = FormSchemaEditorViewModel(repo)

        vm.load("tribeProfile")
        assertEquals("Tribe Profile", vm.state.value.schema.name)
        assertFalse(vm.state.value.isDirty)
        assertTrue(vm.state.value.canSave)

        vm.updateName("Tribe Profile v2")
        assertTrue(vm.state.value.isDirty)
        assertEquals("Tribe Profile v2", vm.state.value.schema.name)

        vm.save()
        val status = vm.state.value.saveStatus
        assertIs<SaveStatus.Success>(status)
        assertFalse(vm.state.value.isDirty, "Dirty flag should clear after successful save.")
        assertEquals(4, vm.state.value.schema.version, "Repo bumped version 3→4.")
        assertEquals(1, repo.saveCalls.size)
    }

    // ---- save fail (network) ----

    @Test
    fun save_networkFailure_setsErrorStatus_keepsDirty() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        repo.nextSaveResult = WriteResult.Err("network unreachable")
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("tribeProfile")
        vm.updateName("Tribe Profile v2")

        vm.save()

        val status = vm.state.value.saveStatus
        assertIs<SaveStatus.Error>(status)
        assertTrue(status.message.contains("network unreachable"))
        assertTrue(vm.state.value.isDirty, "Dirty flag must remain true after a failed save.")
    }

    // ---- save fail (client-side validation) ----

    @Test
    fun save_validationFailure_doesNotCallRepo() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("tribeProfile")

        // Introduce a duplicate field key → validation should fail.
        vm.addNewField(sectionIdx = 0)
        vm.updateFieldKey(s = 0, f = 1, key = "familyName") // dup
        vm.updateFieldLabel(s = 0, f = 1, label = "Dup Family Name")

        assertFalse(vm.state.value.validation.isValid)
        assertFalse(vm.state.value.canSave)

        vm.save()

        val status = vm.state.value.saveStatus
        assertIs<SaveStatus.Error>(status)
        assertTrue(status.message.contains("validation"))
        assertEquals(0, repo.saveCalls.size, "Repo must not be called when client validation fails.")
    }

    // ---- delete success ----

    @Test
    fun delete_success_clearsState() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("tribeProfile")

        vm.delete()

        assertIs<SaveStatus.Success>(vm.state.value.saveStatus)
        assertEquals(listOf("tribeProfile"), repo.deletedIds)
        assertEquals("", vm.state.value.schema.id, "Schema should reset to a fresh blank.")
    }

    // ---- delete fail ----

    @Test
    fun delete_failure_setsErrorStatus() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        repo.nextDeleteResult = WriteResult.Err("permission denied")
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("tribeProfile")

        vm.delete()

        val status = vm.state.value.saveStatus
        assertIs<SaveStatus.Error>(status)
        assertTrue(status.message.contains("permission denied"))
    }

    @Test
    fun delete_blankSchema_doesNotCallRepo() = runTest {
        val repo = FakeFormSchemaRepository()
        val vm = FormSchemaEditorViewModel(repo)
        // No load() → schema is blank, id is empty.
        vm.delete()
        assertIs<SaveStatus.Error>(vm.state.value.saveStatus)
        assertEquals(0, repo.deletedIds.size)
    }

    // ---- load fail ----

    @Test
    fun load_failure_setsErrorStatus() = runTest {
        val repo = FakeFormSchemaRepository()
        repo.nextGetResult = WriteResult.Err("doc missing")
        val vm = FormSchemaEditorViewModel(repo)

        vm.load("ghost")

        assertIs<SaveStatus.Error>(vm.state.value.saveStatus)
        assertFalse(vm.state.value.isLoading)
    }

    // ---- create-new flow (blank id) ----

    @Test
    fun load_blankId_seedsEmptySchema() = runTest {
        val repo = FakeFormSchemaRepository()
        val vm = FormSchemaEditorViewModel(repo)

        vm.load("")

        assertEquals("", vm.state.value.schema.id)
        assertEquals(0, vm.state.value.schema.sections.size)
        assertFalse(vm.state.value.isDirty)
    }

    // ---- reorder methods proxy correctly through the VM ----

    // ---- canSave guard: blank id must block save even when name is set ----

    @Test
    fun canSave_blankId_isFalseEvenWithName() = runTest {
        val repo = FakeFormSchemaRepository()
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("") // seed empty schema (id = "")

        vm.updateName("Fresh Schema")            // name now non-blank
        vm.addNewSection()                       // satisfy validator structure
        vm.updateSectionTitle(0, "Section A")
        vm.addNewField(0)
        vm.updateFieldKey(0, 0, "field1")
        vm.updateFieldLabel(0, 0, "Field 1")

        assertTrue(vm.state.value.validation.isValid, "Validator alone is happy (blank id is not a regex violation).")
        assertFalse(
            vm.state.value.canSave,
            "canSave must be false while schema.id is blank - backend Zod requires a non-empty id.",
        )

        vm.updateId("tribeProfile")
        assertTrue(vm.state.value.canSave, "Setting a valid id flips canSave true.")
    }

    @Test
    fun reorder_methods_changeSchemaInState() = runTest {
        val repo = FakeFormSchemaRepository(saved = mutableMapOf("tribeProfile" to seedSchema()))
        val vm = FormSchemaEditorViewModel(repo)
        vm.load("tribeProfile")
        vm.addNewSection()
        vm.updateSectionTitle(1, "New Section")
        assertEquals(2, vm.state.value.schema.sections.size)
        vm.bumpSectionUp(1)
        assertEquals("New Section", vm.state.value.schema.sections[0].title)
        assertEquals("About", vm.state.value.schema.sections[1].title)
    }
}
