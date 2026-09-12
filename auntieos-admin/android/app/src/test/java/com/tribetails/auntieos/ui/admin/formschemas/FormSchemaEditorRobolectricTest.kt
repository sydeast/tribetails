package com.tribetails.auntieos.ui.admin.formschemas

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.requestFocus
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaSection
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric interaction test for [FormSchemaEditorScreen]. Verifies the
 * editor wires button clicks to the view-model methods that drive add-field,
 * reorder-via-arrows, and save. Uses a mockk fake repository per the pattern
 * established in DynamicFieldsViewModelTest.
 *
 * Per [[robolectric-infra]] this runs at unit-test scope (SDK 35, Java 21
 * toolchain) using ComponentActivity + junit4.v2 compose rule.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h1920dp-xhdpi")
class FormSchemaEditorRobolectricTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun buildSchemaWithTwoFields() = FormSchema(
        id = "tribeProfile",
        name = "Tribe Profile",
        description = "",
        version = 1,
        sections = listOf(
            FormSchemaSection(
                title = "About",
                fields = listOf(
                    FormSchemaField(key = "firstField", label = "First", type = "text"),
                    FormSchemaField(key = "secondField", label = "Second", type = "text"),
                ),
            ),
        ),
    )

    @Test
    fun addFieldButton_addsFieldToSection() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithTwoFields())

        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()

        val before = vm.state.value.sections[0].fields.size

        // The Den layout is taller than the test viewport, so the section's Add-field
        // button starts below the fold; scroll it into view before clicking.
        rule.onNodeWithTag("form-schema-editor-list")
            .performScrollToNode(hasTestTag("add-field-0"))
        rule.onNodeWithTag("add-field-0").performClick()
        rule.waitForIdle()

        assert(vm.state.value.sections[0].fields.size == before + 1) {
            "expected ${before + 1} fields after Add field click, got ${vm.state.value.sections[0].fields.size}"
        }
    }

    @Test
    fun moveFieldDownArrow_invokesReorderOnViewModel() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithTwoFields())

        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()

        // First field's "Move field down" arrow → swap with second
        val downArrows = rule.onAllNodesWithContentDescription("Move field down")
        // first occurrence is on field 1 (index 0)
        downArrows[0].performClick()
        rule.waitForIdle()

        val keys = vm.state.value.sections[0].fields.map { it.key }
        assert(keys == listOf("secondField", "firstField")) {
            "expected swap after down-arrow click, got $keys"
        }
    }

    @Test
    fun saveClick_invokesRepositorySave_whenValid() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithTwoFields())
        coEvery { repo.saveFormSchema(any()) } returns Result.success(Unit)

        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()

        // Save now lives in the sticky AuntieSaveBar footer (the testTag marks the bar
        // container; the clickable is its inner Save button), so click it by label.
        rule.onNodeWithText("Save").performClick()
        rule.waitForIdle()

        coVerify { repo.saveFormSchema(any()) }
    }

    @Test
    fun moveSectionUpArrow_isDisabledForFirstSection() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithTwoFields())

        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()

        val before = vm.state.value.sections.map { it.title }
        // Single section -> up arrow is at index 0 -> should not reorder
        rule.onNodeWithContentDescription("Move section up").performClick()
        rule.waitForIdle()
        val after = vm.state.value.sections.map { it.title }
        assert(before == after) { "expected no-op for first section up arrow, before=$before after=$after" }
    }

    /**
     * The mock's shape (#755): the hero band with the mock's kicker and the
     * "{id} · v{version}" detail line, the schema inputs on the ground with no
     * "Schema details" panel over them, the serif "Sections" bar with its
     * "Add section" ghost, the "Fields (n)" bar with "Add field", and Yes / No
     * for Required rather than a toggle.
     */
    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
    fun drawsTheMock_heroDetail_bareMeta_sectionsBar_andYesNoRequired() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithTwoFields())
        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText("THE DEN · FORM SCHEMAS").assertIsDisplayed()
        rule.onNodeWithText("tribeProfile · v1").assertIsDisplayed()
        rule.onNodeWithText("Sections").assertIsDisplayed()
        rule.onNodeWithText("Add section").assertIsDisplayed()
        rule.onNodeWithText("Fields (2)").assertIsDisplayed()
        rule.onNodeWithText("Add field").assertIsDisplayed()
        // One Yes / No pair per field, two fields.
        assertEquals(2, rule.onAllNodesWithText("Yes").fetchSemanticsNodes().size)
        assertEquals(2, rule.onAllNodesWithText("No").fetchSemanticsNodes().size)
        // The two wrapper panels and their titles are gone.
        assertEquals(0, rule.onAllNodesWithText("Schema details").fetchSemanticsNodes().size)
        // Nothing is dirty on open, so the mock's pill is not drawn.
        assertEquals(0, rule.onAllNodesWithText("UNSAVED").fetchSemanticsNodes().size)
    }

    /**
     * #801: `OptionsField` used to bind its input straight to
     * `field.options.joinToString(", ")` and re-parse it via
     * `updateFieldOptions` on every keystroke, so a typed comma was consumed
     * (splitting drops blank segments) before the next character arrived and
     * a second option could never be typed. This reproduces that keystroke
     * sequence -- one `performTextInput` call per character, so each one sees
     * whatever the previous keystroke left displayed, exactly like a real
     * keyboard -- and checks the comma survives while focused, then that
     * blur is what commits the parsed array to the view model.
     */
    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
    fun optionsField_keepsTypedCommaAndCommitsOnlyOnBlur() {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getFormSchema("tribeProfile") } returns Result.success(buildSchemaWithOneField())

        val vm = FormSchemaEditorViewModel(repository = repo)
        rule.setContent {
            AuntieOSTheme {
                FormSchemaEditorScreen(
                    schemaId = "tribeProfile",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
        rule.waitForIdle()

        // Switch to "Dropdown" (select) so the Options input is drawn.
        rule.onNodeWithText("Dropdown").performClick()
        rule.waitForIdle()

        val optionsField = rule.onNodeWithTag("field-options-0-0")
        optionsField.requestFocus()
        rule.waitForIdle()

        "a,b,c".forEach { ch -> optionsField.performTextInput(ch.toString()) }
        rule.waitForIdle()

        // Still focused, mid-edit: the raw typed text -- comma included -- is
        // what's shown. Re-parsing on every keystroke used to eat it here.
        optionsField.assert(hasText("a,b,c"))
        // Not committed to the view model yet -- that happens on blur, not on
        // every keystroke.
        assertEquals(null, vm.state.value.sections[0].fields[0].options)

        // Move focus to the Label field (shows "Pet types") to blur the
        // options input -- that's what commits it.
        rule.onNodeWithText("Pet types").requestFocus()
        rule.waitForIdle()

        assertEquals(listOf("a", "b", "c"), vm.state.value.sections[0].fields[0].options)
    }

    private fun buildSchemaWithOneField() = FormSchema(
        id = "tribeProfile",
        name = "Tribe Profile",
        description = "",
        version = 1,
        sections = listOf(
            FormSchemaSection(
                title = "About",
                fields = listOf(FormSchemaField(key = "petTypes", label = "Pet types", type = "text")),
            ),
        ),
    )
}
