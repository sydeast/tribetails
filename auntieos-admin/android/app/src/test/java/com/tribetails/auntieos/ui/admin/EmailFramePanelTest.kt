package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.EmailFrameRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #957: the Settings > Email frame panel, rendered, driven, and checked on what reaches the callable. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class EmailFramePanelTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val defaults = mapOf(
        "accentColor" to "#df8431", "headlineColor" to "#11131f", "textColor" to "#11131f",
        "buttonTextColor" to "#ffffff", "pageBackground" to "#fbfbf9", "cardBackground" to "#ffffff",
        "calloutBackground" to "#fff5f5", "footerBackground" to "#11131f", "footerTextColor" to "#fbfbf9",
        "headerText" to "", "footerText" to "Tribe Tails Pet Care. Your Kin's Favorite Auntie.", "logoUrl" to "",
    )

    private fun repo(stored: Map<String, String>): EmailFrameRepository {
        val r = mockk<EmailFrameRepository>()
        val state = EmailFrameRepository.EmailFrameState(stored, defaults, null, null)
        coEvery { r.getEmailFrame() } returns Result.success(state)
        coEvery { r.saveEmailFrame(any()) } returns Result.success(state)
        coEvery { r.resetEmailFrame() } returns Result.success(EmailFrameRepository.EmailFrameState(emptyMap(), defaults, null, null))
        coEvery { r.previewEmailFrame(any()) } returns Result.success(EmailFrameRepository.FramePreview("s", "<p>x</p>", "x"))
        return r
    }

    @Test
    fun `an edit enables Save, and Save sends only that field`() {
        val r = repo(mapOf("accentColor" to "#123456"))
        composeRule.setContent { AuntieOSTheme { EmailFramePanel(vm = EmailFrameViewModel(r)) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Save").assertIsNotEnabled()
        composeRule.onNodeWithTag("emailFrame.footerText").performTextReplacement("Thanks for trusting us")
        composeRule.onNodeWithText("Save").assertIsEnabled().performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) { r.saveEmailFrame(mapOf("footerText" to "Thanks for trusting us")) }
    }

    @Test
    fun `an invalid color keeps Save off and says why`() {
        val r = repo(emptyMap())
        composeRule.setContent { AuntieOSTheme { EmailFramePanel(vm = EmailFrameViewModel(r)) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("emailFrame.accentColor").performTextReplacement("orange")
        composeRule.onNodeWithText("Use a color like #df8431.").assertExists()
        composeRule.onNodeWithText("Save").assertIsNotEnabled()
        coVerify(exactly = 0) { r.saveEmailFrame(any()) }
    }

    @Test
    fun `Reset asks first, then resets`() {
        val r = repo(mapOf("accentColor" to "#123456"))
        composeRule.setContent { AuntieOSTheme { EmailFramePanel(vm = EmailFrameViewModel(r)) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Reset to default").performClick()
        coVerify(exactly = 0) { r.resetEmailFrame() }
        composeRule.onNodeWithText("Reset").performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) { r.resetEmailFrame() }
    }
}
