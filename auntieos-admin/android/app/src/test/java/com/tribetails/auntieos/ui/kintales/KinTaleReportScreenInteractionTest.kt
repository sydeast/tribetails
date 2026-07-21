package com.tribetails.auntieos.ui.kintales

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import com.tribetails.auntieos.visual.AndroidDemoFixtures
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Slice 3 interaction test: the KinTale report draft mode renders an editable
 * headline field and live per-kin pet-mood chips. Typing a headline routes into
 * the VM (and is persisted on blur), and tapping a mood chip writes the selection.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class KinTaleReportScreenInteractionTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun buildVm(): KinTaleReportViewModel {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getKinCareSession("demo-s1") } returns Result.success(AndroidDemoFixtures.kinTaleSession)
        coEvery { repo.getKinfolkById("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinfolk.first())
        coEvery { repo.getKin("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinTaleKin)
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getKinCareReport("demo-report-1") } returns Result.success(AndroidDemoFixtures.kinTaleReport)
        coEvery { repo.getMediaFiles("demo-s1", MediaEntityType.VISIT_LOG) } returns Result.success(AndroidDemoFixtures.kinTaleMedia)
        coEvery { repo.updateKinCareReport(any()) } returns Result.success(Unit)
        coEvery { repo.createKinCareReport(any()) } returns Result.success("demo-report-1")
        val vm = KinTaleReportViewModel(
            repository = repo,
            mediaUploader = mockk<MediaUploadManager>(relaxed = true),
            notifier = mockk<VisitNotifier>(relaxed = true),
        )
        vm.load("demo-s1", "demo-report-1")
        return vm
    }

    private fun renderDraft(vm: KinTaleReportViewModel) {
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                KinTaleReportScreen(
                    sessionId = "demo-s1",
                    existingReportId = "demo-report-1",
                    onBack = {},
                    viewModel = vm,
                )
            }
        }
    }

    @Test
    fun headlineField_isPresentAndEditable() {
        val vm = buildVm()
        renderDraft(vm)

        // The headline placeholder is derived from the recipient name.
        val placeholder = "Add a headline for Wanda Thorne"
        compose.onNodeWithText(placeholder).assertIsDisplayed()

        compose.onNodeWithText(placeholder).performTextInput("Checking on Biscuit")
        assertEquals("Checking on Biscuit", vm.uiState.value.report.title)
    }

    @Test
    fun moodChip_tapWritesSelection() {
        val vm = buildVm()
        renderDraft(vm)

        // "Calm" is a default mood option not currently selected for either kin.
        // There is one chip per kin per mood, so tap the first match.
        compose.onAllNodesWithText("Calm")[0].performClick()

        // At least one kin now carries the "calm" mood key.
        assertEquals(true, vm.uiState.value.report.petMoodSelections.values.any { it == "calm" })
    }
}
