package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #2017, through the real Edit kin screen: Archive used to act at once. It now
 * opens a confirm that names the Kin and says how to bring it back, and only the
 * confirm's own Archive calls the server. Restore still acts at once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
class EditKinArchiveConfirmUiTest {

    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    private val owner = Kinfolk(id = "kf1", firstName = "Ada", lastName = "Lovelace")
    private val willow = Kin(id = "k1", kinfolkId = "kf1", name = "Willow", species = "Dog", sex = "Female", status = "active")

    private fun stub(kin: Kin) {
        coEvery { repo.getKinfolk() } returns Result.success(listOf(owner))
        coEvery { repo.getAllKin() } returns Result.success(listOf(kin))
        coEvery { repo.getKin(any()) } returns Result.success(listOf(kin))
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(kin.id to kin))
        coEvery { repo.getKinfolkById(any()) } returns Result.success(owner)
        coEvery { repo.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.get411ForKin(any()) } returns Result.failure(NoSuchElementException("none"))
        coEvery { repo.getBreeds() } returns Result.failure(IllegalStateException("not in this test"))
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { repo.setKinArchived(any(), any()) } answers { Result.success(if (secondArg<Boolean>()) "archived" else "active") }
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)
    }

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After fun tearDown() = Dispatchers.resetMain()

    private fun show() {
        composeRule.setContent { AuntieOSTheme { EditKinScreen(viewModel = vm, kinId = "k1", onBack = {}) } }
        composeRule.waitForIdle()
    }

    private fun pressArchiveOnTheForm() {
        composeRule.onNodeWithText("Archive").performScrollTo().performClick()
        composeRule.waitForIdle()
    }

    @Test
    fun archiveAsksFirstNamingTheKinAndWritesNothing() {
        stub(willow)
        show()
        pressArchiveOnTheForm()

        composeRule.onNodeWithText(KIN_ARCHIVE_CONFIRM_TITLE).assertExists()
        composeRule.onNodeWithText(kinArchiveConfirmText("Willow")).assertExists()
        coVerify(exactly = 0) { repo.setKinArchived(any(), any()) }
    }

    @Test
    fun cancelOnTheConfirmArchivesNothing() {
        stub(willow)
        show()
        pressArchiveOnTheForm()

        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(KIN_ARCHIVE_CONFIRM_TITLE).assertDoesNotExist()
        coVerify(exactly = 0) { repo.setKinArchived(any(), any()) }
    }

    @Test
    fun theConfirmsOwnArchiveArchivesTheKin() {
        stub(willow)
        show()
        pressArchiveOnTheForm()

        // The form's Archive and the confirm's Archive: the confirm's is the last.
        val archives = composeRule.onAllNodesWithText("Archive")
        archives.fetchSemanticsNodes().let { assertEquals(2, it.size) }
        archives[1].performClick()
        composeRule.waitForIdle()

        coVerify(exactly = 1) { repo.setKinArchived("k1", true) }
    }

    @Test
    fun restoreActsAtOnceWithNoConfirm() {
        stub(willow.copy(status = "archived"))
        show()

        composeRule.onNodeWithText("Restore").performScrollTo().performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(KIN_ARCHIVE_CONFIRM_TITLE).assertDoesNotExist()
        coVerify(exactly = 1) { repo.setKinArchived("k1", false) }
    }

    @Test
    fun theConfirmWordsNameTheKinAndTheWayBack() {
        val words = kinArchiveConfirmText(" Willow ")
        assertEquals(
            "Archive Willow? Willow leaves the Kin list and the household's roster. " +
                "To bring Willow back, choose Archived under Show on the Directory's Kin tab, open Willow, and press Restore.",
            words,
        )
        assertFalse(words.contains('—'))
    }
}
