package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1966: New invoice starts on the business's Payment terms setting, counts
 * visit days on the business's clock, waits visibly for the setting, and says
 * so when it cannot be read.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class NewInvoiceDialogPaymentTermsTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun session(id: String, startTime: String) = ListUninvoicedSessionsResultSession(
        sessionId = id,
        kinfolkId = "kf1",
        serviceType = "Dog walk",
        durationMinutes = 30.0,
        startTime = startTime,
        unitCents = 2500L,
        pricedAs = null,
    )

    private fun mount(
        sessions: List<ListUninvoicedSessionsResultSession>,
        termsSetting: InvoiceTermsSettingState,
        onConfirm: (NewInvoiceRequest) -> Unit = {},
        onRetry: () -> Unit = {},
    ) {
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = true,
                    kinfolk = listOf(Kinfolk(id = "kf1", firstName = "Jamie", lastName = "Halbrook")),
                    todayIso = "2026-12-01",
                    initialKinfolkId = "kf1",
                    onDismiss = {},
                    onConfirm = onConfirm,
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
                    termsSetting = termsSetting,
                    onRetryTermsSetting = onRetry,
                )
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `it starts on the business setting and sends the date it works out`() {
        var captured: NewInvoiceRequest? = null
        mount(
            sessions = listOf(session("s1", "2026-11-16T15:00:00.000Z"), session("s2", "2026-11-20T15:00:00.000Z")),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.NET_14_AFTER_LAST_VISIT),
            onConfirm = { captured = it },
        )
        rule.onNodeWithText("Due 14 days after the last visit").assertExists()
        rule.onNodeWithText("2026-12-04").assertExists()
        rule.onNodeWithText("Create invoice for 2 visits").performClick()
        rule.waitForIdle()
        val request = requireNotNull(captured)
        assertEquals("net_14_after_last_visit", request.termsCode)
        assertEquals("2026-12-04", request.invoice.dueDate)
    }

    @Test
    fun `an evening visit counts on its Chicago day`() {
        mount(
            // 7 PM on Nov 30 in Chicago, 01:00 on Dec 1 in UTC.
            sessions = listOf(session("s1", "2026-12-01T01:00:00.000Z")),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.DUE_ON_LAST_VISIT),
        )
        rule.onNodeWithText("2026-11-30").assertExists()
    }

    @Test
    fun `before-first-visit terms count back from the first visit`() {
        mount(
            sessions = listOf(session("s1", "2026-12-09T15:00:00.000Z"), session("s2", "2026-12-07T15:00:00.000Z")),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.NET_3_BEFORE_FIRST_VISIT),
        )
        rule.onNodeWithText("Due 3 days before the first visit").assertExists()
        rule.onNodeWithText("2026-12-04").assertExists()
    }

    @Test
    fun `an invoice with no visits is due on receipt, and says why`() {
        mount(
            sessions = emptyList(),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.NET_14_AFTER_LAST_VISIT),
        )
        rule.onNodeWithText("Write a blank invoice instead").performClick()
        rule.waitForIdle()
        rule.onNodeWithText(NO_VISITS_DUE_ON_RECEIPT).assertExists()
    }

    @Test
    fun `while the setting loads, Terms waits and Create says why`() {
        mount(
            sessions = listOf(session("s1", "2026-11-20T15:00:00.000Z")),
            termsSetting = InvoiceTermsSettingState(loading = true),
        )
        assertTrue(rule.onAllNodesWithText(TERMS_LOADING).fetchSemanticsNodes().isNotEmpty())
        rule.onNodeWithText("Create invoice for 1 visit").assertIsNotEnabled()
    }

    @Test
    fun `a setting that cannot be read starts on due on receipt and offers a retry`() {
        var retries = 0
        mount(
            sessions = listOf(session("s1", "2026-11-20T15:00:00.000Z")),
            termsSetting = InvoiceTermsSettingState(failed = true),
            onRetry = { retries += 1 },
        )
        rule.onNodeWithText("Due on receipt").assertExists()
        rule.onNodeWithText(TERMS_LOAD_FAILED).assertExists()
        rule.onNodeWithText("Try again").performSemanticsAction(SemanticsActions.OnClick)
        rule.waitForIdle()
        assertEquals(1, retries)
    }
}
