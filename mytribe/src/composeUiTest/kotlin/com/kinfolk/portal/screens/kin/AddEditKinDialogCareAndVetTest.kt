@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kin

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.portal.VetClinic
import com.kinfolk.portal.portal.VetClinicSummary
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * #1908 (owner rulings 2026-11-11, 2026-11-12): the household fills the care
 * facts the admin kept; Medications is one field with the office's notes; the
 * Kin's vet is the household's, read only, unless "Different vet for this Kin"
 * is ticked, which opens the area vet list. No free-text vet box.
 */
class AddEditKinDialogCareAndVetTest {

    private fun kin(ownVetClinicId: String = "") = Kin(
        id = "k1", name = "Biscuit", species = "Dog", breed = "Corgi", ageYears = 4.0, photoUrl = null,
        status = KinStatus.Active, feedingInstructions = null, walkingInstructions = null, medications = null,
        allergies = null, emergencyNotes = null, sitterNotes = null, vetInfo = "Dr A typed long ago",
        ownVetClinicId = ownVetClinicId,
    )

    private val household = VetClinicSummary("home", "Cedar Animal Care", "8055550142", "1 Main St")
    private val clinics = listOf(
        VetClinic("home", "Cedar Animal Care", "8055550142", "1 Main St"),
        VetClinic("own", "Riverside Vets", "8055550199", "2 River Rd"),
    )

    @Test
    fun theFormCarriesTheNewCareFacts_andNoFreeTextVet_andNoSitterWording() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { _, _ -> null }, householdVet = household, vetClinics = clinics)
        }
        waitForIdle()
        for (label in listOf("Stays as", "Routine", "Training / commands", "Food / brand", "Vaccinations", "Medications / health notes", "Notes for your Auntie")) {
            onNodeWithText(label).performScrollTo()
        }
        assertEquals(0, onAllNodesWithText("Sitter Notes").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("Vet").fetchSemanticsNodes().size, "no free-text Vet box")
        assertEquals(0, onAllNodesWithText("Dr A typed long ago").fetchSemanticsNodes().size)
    }

    @Test
    fun aCareFactTyped_isSent_andNothingElseIs() = runComposeUiTest {
        var sent: KinPayload? = null
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { p, _ -> sent = p; null }, householdVet = household, vetClinics = clinics)
        }
        waitForIdle()
        onNodeWithTag("kin-staysAs").performScrollTo().performTextInput("Crate at night")
        onNodeWithTag("kin-vaccinations").performScrollTo().performTextInput("Rabies 2027")
        onNodeWithText("Save").performClick()
        waitForIdle()
        assertEquals("Crate at night", sent?.staysAs)
        assertEquals("Rabies 2027", sent?.vaccinations)
        assertNull(sent?.routine)
        assertNull(sent?.ownVetClinicId)
        assertNull(sent?.vetInfo, "the old vet note is never sent")
    }

    @Test
    fun theHouseholdVetIsShownReadOnly_andTheBoxStartsUnticked() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { _, _ -> null }, householdVet = household, vetClinics = clinics)
        }
        waitForIdle()
        onNodeWithText("From your Tribe Profile: Cedar Animal Care").performScrollTo()
        onNodeWithTag("kin-vet-option-own").assertDoesNotExist()
    }

    @Test
    fun noHouseholdVet_saysSo() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { _, _ -> null }, householdVet = null, vetClinics = clinics)
        }
        waitForIdle()
        onNodeWithText("No vet on your Tribe Profile yet.").performScrollTo()
    }

    @Test
    fun tickingTheBox_opensEveryClinic_andAPickIsSentAsThisKinsVet() = runComposeUiTest {
        var sent: KinPayload? = null
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { p, _ -> sent = p; null }, householdVet = household, vetClinics = clinics)
        }
        waitForIdle()
        onNodeWithTag("kin-vet-own-toggle").performScrollTo().performClick()
        waitForIdle()
        onNodeWithTag("kin-vet-option-home").performScrollTo()
        // The option sits in the list's own scroll inside the dialog's, so the tap
        // goes through its click action rather than a screen position.
        onNodeWithTag("kin-vet-option-own").performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        waitForIdle()
        onNodeWithText("This Kin goes to: Riverside Vets").performScrollTo()
        onNodeWithText("Save").performClick()
        waitForIdle()
        assertEquals("own", sent?.ownVetClinicId)
    }

    @Test
    fun aKinWithItsOwnVet_opensTicked_andUntickingSendsItBackToTheHouseholdVet() = runComposeUiTest {
        var sent: KinPayload? = null
        setThemedContent {
            AddEditKinDialog(initial = kin(ownVetClinicId = "own"), onClose = {}, onSubmit = { p, _ -> sent = p; null }, householdVet = household, vetClinics = clinics)
        }
        waitForIdle()
        onNodeWithText("This Kin goes to: Riverside Vets").performScrollTo()
        onNodeWithTag("kin-vet-own-toggle").performScrollTo().performClick()
        waitForIdle()
        onNodeWithTag("kin-vet-option-own").assertDoesNotExist()
        onNodeWithText("Save").performClick()
        waitForIdle()
        assertNotNull(sent)
        assertEquals("", sent?.ownVetClinicId)
    }

    @Test
    fun theVetListLoading_isShown() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(initial = kin(), onClose = {}, onSubmit = { _, _ -> null }, householdVet = null, vetClinics = emptyList(), vetsLoading = true)
        }
        waitForIdle()
        onNodeWithText("Loading your Tribe Profile vet…").performScrollTo()
        onNodeWithTag("kin-vet-own-toggle").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Loading vets…").performScrollTo()
    }
}
