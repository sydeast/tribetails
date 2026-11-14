package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.settings.withPaymentTerms
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * #1966 on the desktop console: New invoice starts on the business's Payment
 * terms setting, counts visit days on the business's clock, waits visibly for
 * the setting and says so when it cannot be read.
 */
@OptIn(ExperimentalTestApi::class)
class NewInvoicePaymentTermsTest {

    private val picks = listOf(PICK_KINFOLK, KinfolkPick("kf1", "Ada Wren"))

    private fun result(sessions: List<UninvoicedSession>) =
        UninvoicedSessionsResult(sessions, emptyList(), emptyList(), emptyList(), true, 5, false)

    private fun androidx.compose.ui.test.ComposeUiTest.mount(
        sessions: List<UninvoicedSession>,
        termsSetting: InvoiceTermsSettingState,
        onConfirm: (NewInvoiceRequest) -> Unit = {},
        onRetry: () -> Unit = {},
    ) {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-12-01",
                    onDismiss = {},
                    onConfirm = onConfirm,
                    loadUninvoiced = { _, _, _ -> WriteResult.Ok(result(sessions)) },
                    setDoNotInvoice = { _, _, _ -> error("not called in this test") },
                    initialKinfolkId = "kf1",
                    termsSetting = termsSetting,
                    onRetryTermsSetting = onRetry,
                )
            }
        }
    }

    @Test
    fun itStartsOnTheBusinessSettingAndSendsTheDateItWorksOut() = runDesktopComposeUiTest {
        var confirmed: NewInvoiceRequest? = null
        mount(
            sessions = listOf(
                UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-11-16T15:00:00.000Z", 2500L),
                UninvoicedSession("s2", "kf1", "Dog walk", 30.0, "2026-11-20T15:00:00.000Z", 2500L),
            ),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.NET_14_AFTER_LAST_VISIT),
            onConfirm = { confirmed = it },
        )
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 2 visits", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText("Create invoice for 2 visits").performClick()
        waitForIdle()
        val r = assertNotNull(confirmed)
        assertEquals("net_14_after_last_visit", r.termsCode)
        assertEquals("2026-12-04", r.invoice.dueDate)
    }

    @Test
    fun anEveningVisitCountsOnItsChicagoDay() = runDesktopComposeUiTest {
        var confirmed: NewInvoiceRequest? = null
        mount(
            // 7 PM on Nov 30 in Chicago, 01:00 on Dec 1 in UTC.
            sessions = listOf(UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-12-01T01:00:00.000Z", 2500L)),
            termsSetting = InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.DUE_ON_LAST_VISIT),
            onConfirm = { confirmed = it },
        )
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 1 visit", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText("Create invoice for 1 visit").performClick()
        waitForIdle()
        assertEquals("2026-11-30", assertNotNull(confirmed).invoice.dueDate)
    }

    @Test
    fun whileTheSettingLoadsCreateWaitsAndSaysWhy() = runDesktopComposeUiTest {
        mount(
            sessions = listOf(UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-11-20T15:00:00.000Z", 2500L)),
            termsSetting = InvoiceTermsSettingState(loading = true),
        )
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 1 visit", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(onAllNodesWithText(TERMS_LOADING, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        onNodeWithText("Create invoice for 1 visit").assertIsNotEnabled()
    }

    @Test
    fun aSettingThatCannotBeReadSaysSoAndOffersARetry() = runDesktopComposeUiTest {
        var retries = 0
        var confirmed: NewInvoiceRequest? = null
        mount(
            sessions = listOf(UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-11-20T15:00:00.000Z", 2500L)),
            termsSetting = InvoiceTermsSettingState(failed = true),
            onConfirm = { confirmed = it },
            onRetry = { retries += 1 },
        )
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText(TERMS_LOAD_FAILED, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        // Below the visit list, so the harness reports the node clipped; clicked through its
        // semantics, as NewInvoiceDialogTest clicks "Select none".
        onNodeWithText("Try again").performSemanticsAction(SemanticsActions.OnClick)
        waitForIdle()
        assertEquals(1, retries)
        onNodeWithText("Create invoice for 1 visit").performClick()
        waitForIdle()
        assertEquals("due_on_receipt", assertNotNull(confirmed).termsCode)
    }

    @Test
    fun theSettingsReadBecomesTheComposerState() {
        assertEquals(InvoiceTermsSettingState(loading = true), invoiceTermsSettingStateOf(null, loaded = false, error = null))
        assertEquals(InvoiceTermsSettingState(failed = true), invoiceTermsSettingStateOf(null, loaded = true, error = "offline"))
        val stored = BusinessSettings(timeZone = "America/Denver").withPaymentTerms(InvoiceTermsCode.NET_30_BEFORE_FIRST_VISIT)
        assertEquals(
            InvoiceTermsSettingState(paymentTerms = InvoiceTermsCode.NET_30_BEFORE_FIRST_VISIT, timeZone = "America/Denver"),
            invoiceTermsSettingStateOf(stored, loaded = true, error = null),
        )
        // A business that never chose starts on due on receipt.
        assertEquals(InvoiceTermsCode.DUE_ON_RECEIPT, invoiceTermsSettingStateOf(BusinessSettings(), true, null).paymentTerms)
        assertEquals(
            InvoiceTermsCode.DUE_ON_RECEIPT,
            invoiceTermsSettingStateOf(BusinessSettings(invoicePaymentTerms = "custom"), true, null).paymentTerms,
        )
    }
}
