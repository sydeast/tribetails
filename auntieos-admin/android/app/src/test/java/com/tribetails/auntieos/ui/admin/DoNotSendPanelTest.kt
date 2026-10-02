package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.ClearResult
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Page
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Suppression
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #1083: the do-not-send panel, rendered, driven, and checked on what reaches the callable. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class DoNotSendPanelTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val bounced =
        Suppression("gone@example.com", "g***@example.com", "email", "hard_bounce", "smtp2go", 1759400000000L, false, "evt-9")
    private val opted =
        Suppression("+14155552671", "+1******2671", "sms", "opt_out", "admin", 1758000000000L, true, null)
    private val both =
        Suppression("both@example.com", "b***@example.com", "email", "hard_bounce", "smtp2go", 1759500000000L, true, "evt-2")

    private fun repo(rows: List<Suppression> = listOf(bounced, opted)): MessageSuppressionRepository {
        val r = mockk<MessageSuppressionRepository>()
        coEvery { r.list(any(), any()) } returns Result.success(Page(rows, null))
        coEvery { r.clear("gone@example.com") } returns Result.success(ClearResult("email", "g***@example.com", false))
        coEvery { r.clear("both@example.com") } returns Result.success(ClearResult("email", "b***@example.com", true))
        return r
    }

    @Test
    fun `lists each address with its reason and source`() {
        val r = repo()
        composeRule.setContent { AuntieOSTheme { DoNotSendPanel(vm = DoNotSendViewModel(r)) } }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("gone@example.com").assertExists()
        composeRule.onNodeWithText("+14155552671").assertExists()
        composeRule.onNodeWithText("Hard bounce, smtp2go", substring = true).assertExists()
        composeRule.onNodeWithText("smtp2go", substring = true).assertExists()
    }

    @Test
    fun `an opt-out only row has no Clear action`() {
        val r = repo()
        composeRule.setContent { AuntieOSTheme { DoNotSendPanel(vm = DoNotSendViewModel(r)) } }
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("doNotSend.clear.gone@example.com").assertExists()
        composeRule.onNodeWithTag("doNotSend.clear.+14155552671").assertDoesNotExist()
    }

    @Test
    fun `Clear asks first and Keep it sends nothing`() {
        val r = repo()
        composeRule.setContent { AuntieOSTheme { DoNotSendPanel(vm = DoNotSendViewModel(r)) } }
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("doNotSend.clear.gone@example.com").performClick()
        composeRule.onNodeWithText("Clear this bounce?").assertExists()
        coVerify(exactly = 0) { r.clear(any()) }

        composeRule.onNodeWithText("Keep it").performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 0) { r.clear(any()) }
        composeRule.onNodeWithText("gone@example.com").assertExists()
    }

    @Test
    fun `confirming sends the full address and the row goes`() {
        val r = repo()
        composeRule.setContent { AuntieOSTheme { DoNotSendPanel(vm = DoNotSendViewModel(r)) } }
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("doNotSend.clear.gone@example.com").performClick()
        composeRule.onNodeWithText("Clear address").performClick()
        composeRule.waitForIdle()

        coVerify(exactly = 1) { r.clear("gone@example.com") }
        composeRule.onNodeWithTag("doNotSend.row.gone@example.com").assertDoesNotExist()
        composeRule.onNodeWithText("Cleared g***@example.com. It can be mailed again.").assertExists()
    }

    @Test
    fun `clearing a bounce on an opted-out address leaves the opt-out row with no Clear`() {
        val r = repo(listOf(both))
        composeRule.setContent { AuntieOSTheme { DoNotSendPanel(vm = DoNotSendViewModel(r)) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Also opted out", substring = true).assertExists()

        composeRule.onNodeWithTag("doNotSend.clear.both@example.com").performClick()
        composeRule.onNodeWithText("Clear address").performClick()
        composeRule.waitForIdle()

        coVerify(exactly = 1) { r.clear("both@example.com") }
        composeRule.onNodeWithTag("doNotSend.row.both@example.com").assertExists()
        composeRule.onNodeWithTag("doNotSend.clear.both@example.com").assertDoesNotExist()
        composeRule.onNodeWithText("Cleared the bounce on b***@example.com. The opt-out stays.").assertExists()
    }

    @Test
    fun `the labels read the way the web list does`() {
        assertEquals("Hard bounce", doNotSendReasonLabel(bounced))
        assertEquals("Opted out", doNotSendReasonLabel(opted))
        assertEquals("smtp2go", doNotSendSourceLabel(bounced))
        assertEquals("Admin", doNotSendSourceLabel(opted))
        assertEquals("(no time)", doNotSendWhenLabel(0L))
        assertTrue(doNotSendMetaLine(both).startsWith("Hard bounce, Also opted out, smtp2go, "))
    }
}
