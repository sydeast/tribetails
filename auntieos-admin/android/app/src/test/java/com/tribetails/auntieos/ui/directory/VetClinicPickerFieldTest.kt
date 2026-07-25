package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Operator ruling (issue #13, 2026-07-25): Android matches web. The vet field's
 * value is ALWAYS a clinic from the curated catalog; typing is a search and can
 * never on its own produce a saved vet.
 *
 * These are the view half of that contract. The negative case (typing yields
 * nothing) is the one that actually enforces the ruling, so it is first.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VetClinicPickerFieldTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val catalog = listOf(
        VetClinic(id = "riverside", name = "Riverside Animal Hospital", phone = "(512) 555-0100", address = "1 Mill St"),
        VetClinic(id = "themill", name = "The Mill Vet", phone = "(512) 555-0200", address = "9 Oak Rd"),
        VetClinic(id = "er1", name = "Austin Pet ER", phone = "(512) 555-0300", address = "4 Night Ln", isEmergency = true),
    )

    private class Captured {
        var selection: VetClinicSelection? = null
        var created: VetClinic? = null
    }

    /** Mounts the field with a starting selection and records what it emits. */
    private fun mount(
        selection: VetClinicSelection = EMPTY_VET_CLINIC_SELECTION,
        clinics: List<VetClinic> = catalog,
        label: String = "Vet clinic",
        createAsEmergency: Boolean = false,
    ): Captured {
        val captured = Captured()
        composeRule.setContent {
            AuntieOSTheme {
                // Scrollable, matching the LazyColumn the real screen mounts this
                // in. Without it the create form's Save row sits below the test
                // window and a click lands nowhere, which reads as "the button
                // does not work" when the button is simply off screen.
                Column(Modifier.verticalScroll(rememberScrollState())) {
                VetClinicPickerField(
                    label = label,
                    selection = selection,
                    clinics = clinics,
                    onSelectionChange = { captured.selection = it },
                    onCreate = { captured.created = it },
                    createAsEmergency = createAsEmergency,
                )
                }
            }
        }
        return captured
    }

    private fun typeSearch(text: String) =
        composeRule.onNodeWithContentDescription("Vet clinic").performTextInput(text)

    // ── the ruling: no free-text passthrough ─────────────────────────────────

    @Test
    fun `typing a clinic name without selecting it produces NO selection`() {
        val captured = mount()
        typeSearch("Somewhere That Is Not In The Bank")
        composeRule.waitForIdle()
        assertNull("typing alone must never commit a vet", captured.selection)
    }

    @Test
    fun `typing the exact name of a catalog clinic still produces no selection until it is picked`() {
        val captured = mount()
        typeSearch("Riverside Animal Hospital")
        composeRule.waitForIdle()
        assertNull(captured.selection)
    }

    // ── selecting ────────────────────────────────────────────────────────────

    @Test
    fun `picking a suggestion emits the clinic id with the denormalized fields`() {
        val captured = mount()
        typeSearch("riverside")
        composeRule.onNodeWithText("Riverside Animal Hospital").performClick()
        composeRule.waitForIdle()

        assertEquals(
            VetClinicSelection(
                clinicId = "riverside",
                name = "Riverside Animal Hospital",
                phone = "(512) 555-0100",
                address = "1 Mill St",
            ),
            captured.selection,
        )
    }

    @Test
    fun `a prefix match is offered above a substring match`() {
        mount(clinics = listOf(
            VetClinic(id = "sub", name = "The Mill Vet"),
            VetClinic(id = "pre", name = "Millbrook Veterinary"),
        ))
        typeSearch("mill")
        composeRule.onNodeWithText("Millbrook Veterinary").assertIsDisplayed()
        composeRule.onNodeWithText("The Mill Vet").assertIsDisplayed()
    }

    // ── the committed selection affordance ───────────────────────────────────

    @Test
    fun `a selected clinic renders as a committed chip, not as an editable search box`() {
        mount(selection = VetClinicSelection("riverside", "Riverside Animal Hospital", "(512) 555-0100", "1 Mill St"))
        composeRule.onNodeWithText("Riverside Animal Hospital").assertIsDisplayed()
        composeRule.onNodeWithText("(512) 555-0100 · 1 Mill St").assertIsDisplayed()
        // The search box is gone entirely while a clinic is committed: there is
        // nothing to search for, and leaving it would invite free-text editing.
        composeRule.onNodeWithContentDescription("Vet clinic").assertDoesNotExist()
    }

    @Test
    fun `the committed chip carries a clear affordance that empties the selection`() {
        val captured = mount(selection = VetClinicSelection("riverside", "Riverside Animal Hospital"))
        composeRule.onNodeWithContentDescription("Clear Riverside Animal Hospital").performClick()
        composeRule.waitForIdle()
        assertEquals(EMPTY_VET_CLINIC_SELECTION, captured.selection)
    }

    // ── legacy string-only households ────────────────────────────────────────

    @Test
    fun `a legacy vet with no id renders as a valid selection with an honest note`() {
        mount(selection = VetClinicSelection(name = "Old Corner Vet", phone = "after hours: 512-555-0000"))
        composeRule.onNodeWithText("Old Corner Vet").assertIsDisplayed()
        composeRule.onNodeWithText("after hours: 512-555-0000").assertIsDisplayed()
        composeRule.onNodeWithText(VET_CLINIC_UNLINKED_NOTE).assertIsDisplayed()
    }

    @Test
    fun `a linked clinic gets no unlinked note`() {
        mount(selection = VetClinicSelection("riverside", "Riverside Animal Hospital"))
        composeRule.onNodeWithText(VET_CLINIC_UNLINKED_NOTE).assertDoesNotExist()
    }

    @Test
    fun `a legacy vet can be cleared and replaced with a real catalog pick`() {
        val captured = mount(selection = VetClinicSelection(name = "Old Corner Vet"))
        composeRule.onNodeWithContentDescription("Clear Old Corner Vet").performClick()
        composeRule.waitForIdle()
        assertEquals(EMPTY_VET_CLINIC_SELECTION, captured.selection)
    }

    @Test
    fun `a household with no vet at all shows the search box and no note`() {
        mount()
        composeRule.onNodeWithContentDescription("Vet clinic").assertIsDisplayed()
        composeRule.onNodeWithText(VET_CLINIC_UNLINKED_NOTE).assertDoesNotExist()
    }

    // ── the pinned create control ────────────────────────────────────────────

    @Test
    fun `the create button is offered when NOTHING matches, which is when it is needed`() {
        mount()
        typeSearch("Barton Springs")
        composeRule.onNodeWithText(createVetClinicLabel("Barton Springs")).assertIsDisplayed()
    }

    @Test
    fun `the create button is not offered before anything is typed`() {
        mount()
        composeRule.onNodeWithText("as a new vet clinic", substring = true).assertDoesNotExist()
    }

    @Test
    fun `the create button is still offered alongside matches`() {
        mount()
        typeSearch("mill")
        composeRule.onNodeWithText("The Mill Vet").assertIsDisplayed()
        composeRule.onNodeWithText(createVetClinicLabel("mill")).assertIsDisplayed()
    }

    // ── the inline create form: the only way to add a missing clinic ─────────

    @Test
    fun `the create form prefills the name from the query`() {
        mount()
        typeSearch("Barton Springs Animal Clinic")
        composeRule.onNodeWithText(createVetClinicLabel("Barton Springs Animal Clinic")).performClick()
        composeRule.onNodeWithContentDescription("Clinic name")
            .assertIsDisplayed()
        composeRule.onNodeWithText("Barton Springs Animal Clinic").assertIsDisplayed()
    }

    @Test
    fun `an operator can record a clinic the catalog lacks without leaving the screen`() {
        val captured = mount()
        typeSearch("Barton Springs Animal Clinic")
        composeRule.onNodeWithText(createVetClinicLabel("Barton Springs Animal Clinic")).performClick()

        composeRule.onNodeWithContentDescription("Clinic phone").performScrollTo().performTextInput("(512) 555-0400")
        composeRule.onNodeWithContentDescription("Clinic address").performScrollTo().performTextInput("2 Barton Rd")
        composeRule.onNodeWithText("Save clinic").performScrollTo().performClick()
        composeRule.waitForIdle()

        val created = captured.created
        assertTrue("create was never emitted", created != null)
        assertEquals("Barton Springs Animal Clinic", created!!.name)
        assertEquals("(512) 555-0400", created.phone)
        assertEquals("2 Barton Rd", created.address)
        assertTrue(!created.isEmergency)
    }

    @Test
    fun `a blanked name will not save`() {
        val captured = mount()
        typeSearch("Barton Springs")
        composeRule.onNodeWithText(createVetClinicLabel("Barton Springs")).performClick()
        composeRule.onNodeWithContentDescription("Clinic name").performScrollTo().performTextReplacement("")
        composeRule.onNodeWithText("Save clinic").performScrollTo().performClick()
        composeRule.waitForIdle()
        assertNull(captured.created)
        // Asserts the click FIRED and was rejected, rather than the click having
        // silently missed, which a bare assertNull cannot tell apart.
        composeRule.onNodeWithText("Clinic name can't be blank.").assertIsDisplayed()
    }

    @Test
    fun `cancelling the create form creates nothing`() {
        val captured = mount()
        typeSearch("Barton Springs")
        composeRule.onNodeWithText(createVetClinicLabel("Barton Springs")).performClick()
        composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
        composeRule.waitForIdle()
        assertNull(captured.created)
        assertNull(captured.selection)
        // The form is really gone and the search is back, so this is not just a
        // click that missed and changed nothing.
        composeRule.onNodeWithContentDescription("Clinic name").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Vet clinic").assertIsDisplayed()
    }

    // ── the emergency instance ───────────────────────────────────────────────

    @Test
    fun `the emergency instance searches only what it was given`() {
        mount(clinics = catalog.filter { it.isEmergency }, label = "Emergency vet")
        composeRule.onNodeWithContentDescription("Emergency vet").performTextInput("a")
        composeRule.onNodeWithText("Austin Pet ER").assertIsDisplayed()
        composeRule.onNodeWithText("Riverside Animal Hospital").assertDoesNotExist()
    }

    @Test
    fun `the emergency instance creates the clinic already flagged`() {
        val captured = mount(clinics = emptyList(), label = "Emergency vet", createAsEmergency = true)
        composeRule.onNodeWithContentDescription("Emergency vet").performTextInput("Night Owl Pet ER")
        composeRule.onNodeWithText(createVetClinicLabel("Night Owl Pet ER")).performClick()
        composeRule.onNodeWithText("Save clinic").performScrollTo().performClick()
        composeRule.waitForIdle()

        assertTrue("emergency create must land flagged", captured.created?.isEmergency == true)
    }
}
