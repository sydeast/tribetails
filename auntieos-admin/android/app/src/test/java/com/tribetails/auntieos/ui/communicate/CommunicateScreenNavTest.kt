package com.tribetails.auntieos.ui.communicate

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Operator ruling 2026-09-12: marketing blasts is communication, so it is
 * reached from Communicate, not the admin dashboard (`AdminDashboardScreenTest`
 * covers the tile's removal from there). This pins the entry point on THIS
 * screen: a top-bar icon action, the same pattern Calendar uses to reach
 * Scheduling Options.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CommunicateScreenNavTest {

    @get:Rule
    val rule = createComposeRule()

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.listRecentSends() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `the marketing blasts action navigates out to it`() {
        var navigated = false
        val vm = CommunicateViewModel(repo)

        rule.setContent {
            AuntieOSTheme {
                CommunicateScreen(
                    viewModel = vm,
                    onNavigateToMarketingBlasts = { navigated = true },
                )
            }
        }
        rule.waitForIdle()

        rule.onNodeWithContentDescription("Marketing blasts").performClick()

        assertTrue(navigated)
    }
}
