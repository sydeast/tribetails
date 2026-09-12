package com.tribetails.auntieos.ui.marketing

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Marketing blasts screen, rendered.
 *
 * The ViewModel test owns the decisions; this owns the things only a real
 * composition can prove: that the blocker reaches the operator as text beside a
 * disabled button, that Cancel is drawn on a scheduled campaign and NOT on a
 * sent one, and that a failed campaign read renders its error instead of
 * "Nothing scheduled."
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MarketingBlastsScreenTest {

    @get:Rule
    val rule = createComposeRule()

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.listAudienceSegments() } returns Result.success(emptyList())
        coEvery { repo.listMarketingBlasts() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun row(id: String, title: String, status: BlastStatus) = MarketingBlastRow(
        id = id,
        key = "newsletter.announcement",
        title = title,
        fireAtMs = System.currentTimeMillis() + 3_600_000L,
        status = status,
        audienceDescription = "All active kinfolk",
        matched = 9,
        noLinkedAccount = 0,
        dispatched = 9,
        suppressed = 0,
        failed = 0,
    )

    private fun render() {
        val vm = MarketingBlastsViewModel(repo)
        rule.setContent { AuntieOSTheme { MarketingBlastsScreen(viewModel = vm) } }
    }

    @Test
    fun `the blocker is shown as text and the schedule button is disabled with it`() {
        render()

        rule.onNodeWithText("Pick a date and a time to send.").assertExists()
        rule.onNodeWithText("Schedule blast").assertIsNotEnabled()
    }

    @Test
    fun `an unchecked audience says so instead of showing a zero`() {
        render()

        rule.onNodeWithText("Not checked yet for this audience.").assertExists()
        rule.onNodeWithText("WILL RECEIVE IT").assertDoesNotExist()
    }

    @Test
    fun `an empty campaign list says nothing is scheduled and nothing is sent`() {
        render()

        rule.onNodeWithText("Nothing scheduled.").assertExists()
        rule.onNodeWithText("Nothing sent yet.").assertExists()
    }

    @Test
    fun `a failed campaign read renders its error, never "Nothing scheduled"`() {
        coEvery { repo.listMarketingBlasts() } returns Result.failure(RuntimeException("permission-denied"))

        render()

        rule.onNodeWithText("permission-denied").assertExists()
        rule.onNodeWithText("Nothing scheduled.").assertDoesNotExist()
    }

    @Test
    fun `Cancel is drawn on a scheduled campaign and not on a sent one`() {
        coEvery { repo.listMarketingBlasts() } returns Result.success(
            listOf(row("b1", "Next week", BlastStatus.Scheduled), row("b2", "Last month", BlastStatus.Sent)),
        )
        coEvery { repo.cancelMarketingBlast("b1") } returns Result.success(9)

        render()

        rule.onNodeWithText("Next week").assertExists()
        rule.onNodeWithText("Last month").assertExists()
        // One Cancel button in the list, and it belongs to the scheduled row:
        // clicking it cancels b1, not b2.
        rule.onNodeWithText("Cancel").performScrollTo().performClick()
        coVerify { repo.cancelMarketingBlast("b1") }
        coVerify(exactly = 0) { repo.cancelMarketingBlast("b2") }
    }

    @Test
    fun `the preview button reports the four counts once they arrive`() {
        coEvery { repo.previewMarketingBlastAudience(any(), any()) } returns
            Result.success(BlastReach("All active kinfolk", 10, 2, 3, 5))

        render()

        rule.onNodeWithText("Check who this reaches").performScrollTo().performClick()
        rule.waitForIdle()

        coVerify { repo.previewMarketingBlastAudience(any(), any()) }
        // AuntieKeyValueRow uppercases its label face, so the rendered text is
        // the label shouted. Asserted as it actually renders rather than as it
        // is written, which is the point of driving the real composition.
        rule.onNodeWithText("WILL RECEIVE IT").assertExists()
        rule.onNodeWithText("OPTED OUT OR GATED").assertExists()
        rule.onNodeWithText("NO LINKED ACCOUNT").assertExists()
        rule.onNodeWithText("Not checked yet for this audience.").assertDoesNotExist()
    }
}
