package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FormSchemaEditorViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk(relaxed = true)
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    private fun vm() = FormSchemaEditorViewModel(repository = mockRepo)

    // ── load ────────────────────────────────────────────────────────────────

    @Test fun `load null id seeds blank-new editor with one empty section`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        advanceUntilIdle()

        val s = v.state.value
        assertTrue(s.isNew)
        assertEquals("", s.schemaId)
        assertEquals(1, s.sections.size)
    }

    @Test fun `load existing schema populates editor state`() = runTest(testDispatcher) {
        coEvery { mockRepo.getFormSchema("foo") } returns Result.success(
            FormSchema(
                id = "foo",
                name = "Foo Schema",
                description = "desc",
                version = 7,
                sections = listOf(FormSchemaSection(title = "S1", fields = listOf(FormSchemaField(key = "a", label = "A")))),
            ),
        )

        val v = vm()
        v.load("foo")
        advanceUntilIdle()

        val s = v.state.value
        assertFalse(s.isNew)
        assertEquals("foo", s.schemaId)
        assertEquals("Foo Schema", s.name)
        assertEquals(7, s.originalVersion)
        assertEquals(1, s.sections.size)
        assertEquals("a", s.sections[0].fields[0].key)
    }

    @Test fun `load missing schema surfaces error`() = runTest(testDispatcher) {
        coEvery { mockRepo.getFormSchema("missing") } returns Result.success(null)

        val v = vm()
        v.load("missing")
        advanceUntilIdle()

        assertNotNull(v.state.value.errorMessage)
    }

    @Test fun `load repository failure surfaces error`() = runTest(testDispatcher) {
        coEvery { mockRepo.getFormSchema(any()) } returns Result.failure(RuntimeException("net down"))

        val v = vm()
        v.load("x")
        advanceUntilIdle()

        val msg = v.state.value.errorMessage.orEmpty()
        assertTrue("expected fail-loud message, got $msg", msg.contains("Failed to load") && msg.contains("net down"))
    }

    // ── edit ────────────────────────────────────────────────────────────────

    @Test fun `updateName marks dirty`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        assertFalse(v.state.value.isDirty)
        v.updateName("Hello")
        assertTrue(v.state.value.isDirty)
        assertEquals("Hello", v.state.value.name)
    }

    @Test fun `addSection appends an empty section`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        val before = v.state.value.sections.size
        v.addSection()
        assertEquals(before + 1, v.state.value.sections.size)
    }

    @Test fun `addField appends an empty field to section`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.addField(0)
        assertEquals(1, v.state.value.sections[0].fields.size)
    }

    @Test fun `updateField transform replaces field`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.addField(0)
        v.updateFieldKey(0, 0, "myKey")
        assertEquals("myKey", v.state.value.sections[0].fields[0].key)
    }

    @Test fun `moveSection delegates to reorder helper`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.addSection() // [s0, s1]
        v.updateSectionTitle(0, "A")
        v.updateSectionTitle(1, "B")
        v.moveSection(0, 1)
        assertEquals(listOf("B", "A"), v.state.value.sections.map { it.title })
    }

    @Test fun `updateFieldOptions splits on commas and newlines`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.addField(0)
        v.updateFieldOptions(0, 0, "alpha\nbeta, gamma")
        assertEquals(listOf("alpha", "beta", "gamma"), v.state.value.sections[0].fields[0].options)
    }

    // ── save success / fail ─────────────────────────────────────────────────

    @Test fun `save success calls repository and sets SAVED status`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveFormSchema(any()) } returns Result.success(Unit)
        val v = vm()
        v.load(null)
        v.updateId("tribeProfile")
        v.updateName("Tribe Profile")
        v.addField(0)
        v.updateFieldKey(0, 0, "k")
        v.updateFieldLabel(0, 0, "L")
        v.updateSectionTitle(0, "S")

        v.save()
        advanceUntilIdle()

        assertEquals(SaveStatus.SAVED, v.state.value.saveStatus)
        assertFalse(v.state.value.isDirty)
        coVerify { mockRepo.saveFormSchema(any()) }
    }

    @Test fun `save validation failure does not call repository`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null) // blank id+name → invalid
        v.save()
        advanceUntilIdle()

        assertEquals(SaveStatus.VALIDATION_FAILED, v.state.value.saveStatus)
        assertNotNull(v.state.value.errorMessage)
        coVerify(exactly = 0) { mockRepo.saveFormSchema(any()) }
    }

    @Test fun `save repository failure surfaces fail-loud error`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveFormSchema(any()) } returns Result.failure(RuntimeException("boom"))
        val v = vm()
        v.load(null)
        v.updateId("x")
        v.updateName("X")
        v.updateSectionTitle(0, "S")
        v.addField(0)
        v.updateFieldKey(0, 0, "k")
        v.updateFieldLabel(0, 0, "L")

        v.save()
        advanceUntilIdle()

        assertEquals(SaveStatus.FAILED, v.state.value.saveStatus)
        val msg = v.state.value.errorMessage.orEmpty()
        assertTrue("expected fail-loud save error, got $msg", msg.contains("Save failed") && msg.contains("boom"))
    }

    @Test fun `save payload preserves original version`() = runTest(testDispatcher) {
        coEvery { mockRepo.getFormSchema("foo") } returns Result.success(
            FormSchema(
                id = "foo", name = "F", version = 4,
                sections = listOf(FormSchemaSection(title = "S",
                    fields = listOf(FormSchemaField(key = "k", label = "L")))),
            ),
        )
        val captured = slot<FormSchema>()
        coEvery { mockRepo.saveFormSchema(capture(captured)) } returns Result.success(Unit)

        val v = vm()
        v.load("foo")
        advanceUntilIdle()
        v.save()
        advanceUntilIdle()

        assertEquals(4, captured.captured.version)
        assertEquals("foo", captured.captured.id)
    }

    // ── delete ──────────────────────────────────────────────────────────────

    @Test fun `delete success invokes onDeleted callback`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteFormSchema("foo") } returns Result.success(Unit)
        coEvery { mockRepo.getFormSchema("foo") } returns Result.success(
            FormSchema(id = "foo", name = "F", version = 1,
                sections = listOf(FormSchemaSection(title = "S",
                    fields = listOf(FormSchemaField(key = "k", label = "L"))))),
        )
        val v = vm()
        v.load("foo")
        advanceUntilIdle()

        var deletedCalled = false
        v.delete { deletedCalled = true }
        advanceUntilIdle()

        assertTrue(deletedCalled)
        assertNull(v.state.value.errorMessage)
        coVerify { mockRepo.deleteFormSchema("foo") }
    }

    @Test fun `delete failure surfaces fail-loud error`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteFormSchema(any()) } returns Result.failure(RuntimeException("network"))
        coEvery { mockRepo.getFormSchema(any()) } returns Result.success(
            FormSchema(id = "foo", name = "F", version = 1,
                sections = listOf(FormSchemaSection(title = "S",
                    fields = listOf(FormSchemaField(key = "k", label = "L"))))),
        )
        val v = vm()
        v.load("foo")
        advanceUntilIdle()

        var deletedCalled = false
        v.delete { deletedCalled = true }
        advanceUntilIdle()

        assertFalse(deletedCalled)
        assertEquals(SaveStatus.FAILED, v.state.value.saveStatus)
        val msg = v.state.value.errorMessage.orEmpty()
        assertTrue("expected fail-loud delete error, got $msg", msg.contains("Delete failed") && msg.contains("network"))
    }

    @Test fun `delete on blank id is no-op`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        var deletedCalled = false
        v.delete { deletedCalled = true }
        advanceUntilIdle()
        assertFalse(deletedCalled)
        coVerify(exactly = 0) { mockRepo.deleteFormSchema(any()) }
    }

    // ── transient messages ──────────────────────────────────────────────────

    @Test fun `clearTransientMessages clears error and success`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.save() // triggers validation failure → error message
        advanceUntilIdle()
        assertNotNull(v.state.value.errorMessage)
        v.clearTransientMessages()
        assertNull(v.state.value.errorMessage)
        assertNull(v.state.value.successMessage)
    }

    @Test fun `snapshot reflects current editor state`() = runTest(testDispatcher) {
        val v = vm()
        v.load(null)
        v.updateId("foo")
        v.updateName("F")
        v.updateSectionTitle(0, "S")
        v.addField(0)
        v.updateFieldType(0, 0, FormSchemaFieldType.SELECT)
        val snap = v.snapshot()
        assertEquals("foo", snap.id)
        assertEquals("F", snap.name)
        assertEquals("S", snap.sections[0].title)
        assertEquals("select", snap.sections[0].fields[0].type)
    }
}
