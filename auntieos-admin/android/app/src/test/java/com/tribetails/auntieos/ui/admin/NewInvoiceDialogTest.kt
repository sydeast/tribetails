package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric mount test for [NewInvoiceDialog] (slice 2 composer): verifies the
 * dialog composes its title, the household picker seeded from the kinfolk
 * directory, and the Save action. The submit/validation behaviour itself is
 * covered exhaustively by [NewInvoiceValidationTest] (pure) and the VM routing
 * by AdminDataViewModelTest; this test guards that the composer actually mounts
 * and surfaces the picker + action so the CTA is not a dead control.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h1920dp-xhdpi")
class NewInvoiceDialogTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val kinfolk = listOf(
        Kinfolk(id = "kf1", firstName = "Jamie", lastName = "Halbrook"),
    )

    @Test
    fun composerMountsWithPickerAndSaveAction() {
        var confirmed: Invoice? = null
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = true,
                    kinfolk = kinfolk,
                    onDismiss = {},
                    onConfirm = { inv, _ -> confirmed = inv },
                )
            }
        }
        rule.waitForIdle()

        rule.onNodeWithText("New invoice").assertExists()
        rule.onNodeWithText("Save").assertExists()
        rule.onNodeWithText("Cancel").assertExists()
        // Household picker seeded from the kinfolk directory (sentinel prompt).
        rule.onNodeWithText("Pick a household...").assertExists()
    }

    @Test
    fun hiddenWhenNotVisible() {
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = false,
                    kinfolk = kinfolk,
                    onDismiss = {},
                    onConfirm = { _, _ -> },
                )
            }
        }
        rule.waitForIdle()
        rule.onNodeWithText("New invoice").assertDoesNotExist()
    }

    @Test
    fun quoteModeShowsQuoteTitleAndSendToggleAndCreateQuoteCta() {
        // PART B: the same composer in quoteMode reads "New quote", offers the
        // Send-to-kinfolk toggle, and the CTA mints a quote (createQuote).
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = true,
                    kinfolk = kinfolk,
                    quoteMode = true,
                    onDismiss = {},
                    onConfirm = { _, _ -> },
                )
            }
        }
        rule.waitForIdle()

        rule.onNodeWithText("New quote").assertExists()
        rule.onNodeWithText("Create quote").assertExists()
        rule.onNodeWithText("Send to kinfolk").assertExists()
    }
}
