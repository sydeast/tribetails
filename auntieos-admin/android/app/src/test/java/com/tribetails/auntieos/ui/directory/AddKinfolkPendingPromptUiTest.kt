package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinfolkCreated
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.Called
import io.mockk.clearMocks
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #890, through the real Add Kinfolk screen: opening Add on a household whose
 * Emergency Contact did not save shows the Continue or Discard choice, with the
 * copy admin web and the desktop console use, before any form.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class AddKinfolkPendingPromptUiTest {

    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    private val continueLabel = "Continue adding the Emergency Contact for Jamie Halbrook"

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)

        // Add created the household, its contact failed, and the operator left.
        coEvery { repo.createKinfolkComplete(any(), any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-890"), null)) }
        coEvery { repo.saveEmergencyContacts("kf-890", any()) } returns Result.failure(Exception("offline"))
        vm.updateFirstName("Jamie")
        vm.updateLastName("Halbrook")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
        vm.leaveAddKinfolk()
        clearMocks(repo, answers = false, recordedCalls = true, childMocks = false, verificationMarks = true, exclusionRules = false)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun showAdd() = composeRule.setContent {
        AuntieOSTheme { AddKinfolkScreen(viewModel = vm, onBack = {}, onSaved = {}) }
    }

    @Test
    fun opensOnTheChoiceWithTheSameCopyAsWebAndDesktop() {
        showAdd()
        composeRule.onNodeWithText(continueLabel).assertExists()
        composeRule.onNodeWithText("Discard").assertExists()
        composeRule.onNodeWithText(
            "Jamie Halbrook was created, but the Emergency Contact did not save. The household shows No Emergency Contact until it is saved.",
        ).assertExists()
        composeRule.onNodeWithText("Discard starts a new Add and leaves Jamie Halbrook as it is.").assertExists()
        assertTrue(composeRule.onAllNodesWithText("BASIC INFORMATION").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun continueShowsTheLockedHouseholdReadyToSaveItsContact() {
        showAdd()
        composeRule.onNodeWithText(continueLabel).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("BASIC INFORMATION").assertExists()
        composeRule.onNodeWithText("Save Emergency Contact").assertExists()
        assertEquals("kf-890", vm.addKinfolkState.value.createdKinfolkId)
    }

    @Test
    fun discardShowsABlankAddAndWritesNothing() {
        showAdd()
        composeRule.onNodeWithText("Discard").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("BASIC INFORMATION").assertExists()
        composeRule.onNodeWithText("Save").assertExists()
        assertTrue(composeRule.onAllNodesWithText("Save Emergency Contact").fetchSemanticsNodes().isEmpty())
        verify { repo wasNot Called }
    }

    /** #907 review item 1(b): a duplicateOf answer hands the operator to that household, never onSaved. */
    @Test
    fun aDuplicateOfAnswerOpensThatHouseholdInsteadOfReportingSaved() {
        vm.discardPendingAdd()
        coEvery { repo.createKinfolkComplete(any(), any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-existing"), "kf-existing")) }
        vm.updateFirstName("Jamie")
        vm.updateLastName("Halbrook")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
        var opened: String? = null
        var saved = false
        composeRule.setContent {
            AuntieOSTheme { AddKinfolkScreen(viewModel = vm, onBack = {}, onSaved = { saved = true }, onDuplicate = { opened = it }) }
        }
        composeRule.waitForIdle()
        assertEquals("kf-existing", opened)
        assertEquals(false, saved)
    }
}
