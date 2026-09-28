@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

/** Q6: the account credit history section on the Invoices screen. */
class CreditHistorySectionTest {

    private fun stubInvoices(fake: FakeFunctionsClient) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 2500L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }

    @Test
    fun billingPerson_seesCreditReasonAndStatus() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake)
        fake.stub("getAccountCreditHistory", buildJsonObject {
            put("ok", true)
            put("kinfolkId", "3")
            put("accountBalanceCents", 2500)
            put("credits", buildJsonArray {
                add(buildJsonObject {
                    put("creditId", "crd_1")
                    put("amountCents", 2500)
                    put("reason", "Missed visit on Sept 12")
                    put("givenAtMs", 1_789_225_200_000L)
                    put("remainingCents", 2500)
                    put("fullyAppliedAtMs", JsonNull)
                    put("applications", buildJsonArray {})
                })
            })
            put("uses", buildJsonArray {})
        })
        setThemedContent { InvoicesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText(CREDIT_HISTORY_TITLE).assertIsDisplayed()
        onNodeWithText("Missed visit on Sept 12").assertIsDisplayed()
        onNodeWithText("Not used yet").assertIsDisplayed()
    }

    @Test
    fun noBillingAccess_hidesTheSection_andInvoicesStillRender() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake)
        fake.stubError("getAccountCreditHistory", IllegalStateException("permission-denied"))
        setThemedContent { InvoicesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No open invoices").assertIsDisplayed()
        onNodeWithText(CREDIT_HISTORY_TITLE).assertDoesNotExist()
        onNodeWithText(CREDIT_HISTORY_LOAD_ERROR).assertDoesNotExist()
    }

    @Test
    fun otherFailure_showsTheInlineMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake)
        fake.stubError("getAccountCreditHistory", IllegalStateException("deadline-exceeded"))
        setThemedContent { InvoicesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText(CREDIT_HISTORY_LOAD_ERROR).assertIsDisplayed()
        onNodeWithText("No open invoices").assertIsDisplayed()
    }
}
