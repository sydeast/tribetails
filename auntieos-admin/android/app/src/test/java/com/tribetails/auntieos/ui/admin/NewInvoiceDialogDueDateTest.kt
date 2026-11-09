package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1593 on the Android New invoice screen: a discount larger than the subtotal
 * shows no total and holds Create back, and letters in the blank path's total
 * are refused under the field. The rules are asserted purely in
 * [InvoiceDueDateCheckTest]; this checks they reach the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class NewInvoiceDialogDueDateTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun mount(sessions: List<ListUninvoicedSessionsResultSession>) {
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = true,
                    kinfolk = listOf(Kinfolk(id = "kf1", firstName = "Jamie", lastName = "Halbrook")),
                    todayIso = "2026-11-05",
                    initialKinfolkId = "kf1",
                    onDismiss = {},
                    onConfirm = {},
                    onOpenVisit = {},
                    loadUninvoiced = { _, _, _ ->
                        Result.success(
                            ListUninvoicedSessionsResult(
                                sessions = sessions,
                                unpriceable = emptyList(),
                                unplaceable = emptyList(),
                                excluded = emptyList(),
                                rateCardLoaded = true,
                                scanned = sessions.size.toLong(),
                                truncated = false,
                            ),
                        )
                    },
                    setDoNotInvoice = { ids, flag, _ ->
                        Result.success(SetSessionDoNotInvoiceResult(ok = true, doNotInvoice = flag, changed = ids, unchanged = emptyList()))
                    },
                )
            }
        }
        rule.waitForIdle()
    }

    private val walk = ListUninvoicedSessionsResultSession(
        sessionId = "s1",
        kinfolkId = "kf1",
        serviceType = "Dog walk",
        durationMinutes = 30.0,
        startTime = "2026-11-01T15:00:00.000Z",
        unitCents = 2500L,
        pricedAs = null,
    )

    @Test
    fun `a discount larger than the subtotal shows no total and holds Create back`() {
        mount(listOf(walk))
        // The first text field on the work path, the visits being priced: the
        // whole-invoice discount. Its label is a sibling Text, not on the node.
        rule.onAllNodes(hasSetTextAction())[0].performScrollTo().performTextInput("77")
        rule.waitForIdle()

        rule.onNodeWithText("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", useUnmergedTree = true)
            .assertExists()
        rule.onNodeWithText("Total -", useUnmergedTree = true).assertExists()
        assertEquals(0, rule.onAllNodesWithText("-\$52.00", substring = true, useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onNodeWithText("Create invoice for 1 visit").assertIsNotEnabled()
    }

    @Test
    fun `letters in the blank total are refused under the field, once`() {
        mount(emptyList())
        rule.onNodeWithText("Write a blank invoice instead").performClick()
        rule.waitForIdle()
        // The first text field on the blank path: the typed total.
        rule.onAllNodes(hasSetTextAction())[0].performScrollTo().performTextInput("abc")
        rule.waitForIdle()

        assertEquals(1, rule.onAllNodesWithText(BLANK_TOTAL_PROBLEM, useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onNodeWithText("Create invoice").assertIsNotEnabled()
    }
}
