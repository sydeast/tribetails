package com.tribetails.auntieos.ui.kintales

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.runtime.CompositionLocalProvider
import com.tribetails.auntieos.config.FeatureFlags
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Slice 5 UI test: a SENT KinTale report renders (a) the GPS RouteMap
 * Distance/Duration stats from the session's persisted gpsSummary route, and
 * (b) the new Delivery panel (Sent via / Receipt) with NO "SUGGESTION" pill,
 * since the send pipeline now writes a real deliveryReceiptId. A blank receipt
 * omits the Receipt row (fail-loud by omission).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class KinTaleReportDeliveryTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun buildVm(receiptId: String): KinTaleReportViewModel {
        val sentReport = AndroidDemoFixtures.kinTaleReport.copy(
            status = ReportStatus.SENT.name,
            sentAt = "2026-05-30T09:50:00Z",
            sentVia = "catalog",
            deliveryReceiptId = receiptId,
        )
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { kinCareRepo.getKinCareSession("demo-s1") } returns Result.success(AndroidDemoFixtures.kinTaleSession)
        coEvery { repo.getKinfolkById("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinfolk.first())
        coEvery { repo.getKin("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinTaleKin)
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { kinCareRepo.getKinCareReport("demo-report-1") } returns Result.success(sentReport)
        coEvery { repo.getMediaFiles("demo-s1", MediaEntityType.VISIT_LOG) } returns Result.success(AndroidDemoFixtures.kinTaleMedia)
        val vm = KinTaleReportViewModel(
            repository = repo,
            kinCareRepository = kinCareRepo,
            mediaUploader = mockk<MediaUploadManager>(relaxed = true),
            notifier = mockk<VisitNotifier>(relaxed = true),
        )
        vm.load("demo-s1", "demo-report-1")
        return vm
    }

    private fun render(vm: KinTaleReportViewModel) {
        compose.setContent {
            // Disable the live comment thread so the test doesn't reach the real
            // KinTaleCommentsRepository -> Firebase (not initialized under test).
            // The Delivery + GPS panels under test are unaffected by this flag.
            CompositionLocalProvider(
                LocalFeatureFlags provides FeatureFlags(kintaleCommentThread = false),
            ) {
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
    }

    @Test
    fun sentReport_showsGpsRouteStats() {
        render(buildVm(receiptId = "n8n_99"))
        // RouteMap renders the Distance/Duration/Pings stat labels (uppercased).
        // The RouteMap sits below the fold in the scrolling report, so assert
        // existence (the labels composed), not on-screen layout — matching the
        // sibling delivery-panel tests. assertIsDisplayed() flakes here because
        // Robolectric can't confirm viewport bounds for an off-screen node.
        compose.onNodeWithText("DISTANCE").assertExists()
        compose.onNodeWithText("DURATION").assertExists()
    }

    @Test
    fun sentReport_showsDeliveryReceiptWithoutSuggestionPill() {
        render(buildVm(receiptId = "n8n_99"))
        // The Delivery panel + receipt row render with the real id. The panel sits
        // below the fold in the scrolling report, so assert existence, not on-screen.
        compose.onNodeWithText("Delivery").assertExists()
        compose.onNodeWithText("RECEIPT").assertExists()
        compose.onNodeWithText("n8n_99").assertExists()
        // No SUGGESTION pill anywhere on the now-reliable receipt.
        compose.onAllNodesWithText("SUGGESTION").assertCountEquals0()
    }

    @Test
    fun sentReport_blankReceipt_omitsReceiptRow() {
        render(buildVm(receiptId = ""))
        // Sent via still shows (suppressed dispatch), but the Receipt row is gone.
        compose.onNodeWithText("Delivery").assertExists()
        compose.onNodeWithText("SENT VIA").assertExists()
        compose.onAllNodesWithText("RECEIPT").assertCountEquals0()
    }
}

/** Tiny extension so the assertion reads cleanly. */
private fun androidx.compose.ui.test.SemanticsNodeInteractionCollection.assertCountEquals0() =
    this.assertCountEquals(0)
