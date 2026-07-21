package com.tribetails.auntieos.ui.kintales

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.CommentsState
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.KinTaleComment
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
import com.tribetails.auntieos.visual.AndroidDemoFixtures
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
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
 * Slice 4 (spec 11 item 6.2) UI test: a SENT KinTale renders the live comment
 * thread, tapping Reply sets the reply target, and typing + Post calls
 * addKinTaleComment with the correct {kinfolkId, taleId, parentCommentId}. A
 * failing repo surfaces a fail-loud error banner.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class KinTaleReportScreenCommentTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val sentReport: KinCareReport = AndroidDemoFixtures.kinTaleReport.copy(
        id = "demo-report-1",
        kinfolkId = "demo-kf-1",
        status = ReportStatus.SENT.name,
    )

    private fun repo(): AuntieRepository {
        val repo = mockk<AuntieRepository>(relaxed = true)
        coEvery { repo.getKinCareSession("demo-s1") } returns Result.success(AndroidDemoFixtures.kinTaleSession)
        coEvery { repo.getKinfolkById("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinfolk.first())
        coEvery { repo.getKin("demo-kf-1") } returns Result.success(AndroidDemoFixtures.kinTaleKin)
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getKinCareReport("demo-report-1") } returns Result.success(sentReport)
        coEvery { repo.getMediaFiles("demo-s1", MediaEntityType.VISIT_LOG) } returns Result.success(AndroidDemoFixtures.kinTaleMedia)
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        return repo
    }

    private fun buildVm(comments: KinTaleCommentsRepository): KinTaleReportViewModel {
        val vm = KinTaleReportViewModel(
            repository = repo(),
            mediaUploader = mockk<MediaUploadManager>(relaxed = true),
            notifier = mockk<VisitNotifier>(relaxed = true),
            commentsRepo = comments,
        )
        vm.load("demo-s1", "demo-report-1")
        return vm
    }

    private fun render(vm: KinTaleReportViewModel) {
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
    fun thread_renders_rows_reply_then_post_sends_correct_payload() {
        val comments = mockk<KinTaleCommentsRepository>(relaxed = true)
        every { comments.streamComments("demo-report-1") } returns flowOf(
            CommentsState.Data(
                listOf(
                    KinTaleComment(id = "c1", authorRole = "kinfolk", body = "Thank you so much!", createdAtMs = 1),
                ),
            ),
        )
        val taleSlot = slot<String>()
        val kinfolkSlot = slot<String>()
        val parentSlot = slot<String?>()
        coEvery {
            comments.addComment(capture(taleSlot), capture(kinfolkSlot), any(), captureNullable(parentSlot))
        } returns Result.success("new-id")

        val vm = buildVm(comments)
        render(vm)

        // The kinfolk comment row renders.
        compose.onNodeWithText("Thank you so much!").performScrollTo().assertIsDisplayed()

        // Tap Reply to set the reply target.
        compose.onNodeWithText("Reply").performScrollTo().performClick()

        // Compose a reply and post it.
        compose.onNodeWithText("Write a note back to the kinfolk...").performScrollTo()
            .performTextInput("You're welcome!")
        compose.onNodeWithText("Post reply").performScrollTo().performClick()

        coVerify { comments.addComment("demo-report-1", "demo-kf-1", any(), "c1") }
    }

    @Test
    fun read_error_shows_fail_loud_banner() {
        val comments = mockk<KinTaleCommentsRepository>(relaxed = true)
        every { comments.streamComments("demo-report-1") } returns
            flowOf(CommentsState.Error("permission-denied"))

        val vm = buildVm(comments)
        render(vm)

        compose.onNodeWithText("Could not load comments: permission-denied", substring = true)
            .performScrollTo().assertIsDisplayed()
    }
}
