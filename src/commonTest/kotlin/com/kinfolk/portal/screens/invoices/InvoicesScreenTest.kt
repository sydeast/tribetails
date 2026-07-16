@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class InvoicesScreenTest {

    private fun emptyStub(fake: FakeFunctionsClient) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }

    @Test
    fun empty_rendersBothEmptyMessages() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        emptyStub(fake)
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("No open invoices").assertIsDisplayed()
        onNodeWithText("No paid invoices yet").assertIsDisplayed()
    }

    @Test
    fun openAndPaid_rendersBothCards() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1001")
                    put("kinfolkId", "3")
                    put("amountDue", 120.0)
                    put("total", 120.0)
                    put("isPaid", false)
                    put("status", "open")
                    put("client", "Buddy (Nora)")
                    put("dueDate", "Sep 17, 2025")
                })
            })
            put("paid", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1000")
                    put("kinfolkId", "3")
                    put("amountDue", 0.0)
                    put("total", 250.0)
                    put("isPaid", true)
                    put("status", "paid")
                    put("client", "Buddy (Nora)")
                    put("date", "Aug 11, 2025")
                })
            })
            put("credits", buildJsonArray {})
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Invoice #1001").assertIsDisplayed()
        onNodeWithText("PENDING").assertIsDisplayed()
        onNodeWithText("PAID").assertIsDisplayed()
        onNodeWithText("Pay \$120.00").assertIsDisplayed()
    }

    @Test
    fun creditsBucket_showsRedeemButtons() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {
                add(buildJsonObject {
                    put("id", "credit-1")
                    put("kinfolkId", "3")
                    put("amountDue", -25.0)
                    put("total", -25.0)
                    put("status", "credit")
                    put("creditAmountCents", 2500L)
                    put("client", "Buddy (Nora)")
                    put("originalPaymentIntentId", "pi_xyz")
                })
            })
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Credits").assertIsDisplayed()
        onNodeWithText("Save to Account Balance").assertIsDisplayed()
        onNodeWithText("Return to Original Payment Method").assertIsDisplayed()
    }

    @Test
    fun creditWithoutOriginalPi_disablesReturnButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {
                add(buildJsonObject {
                    put("id", "credit-no-pi")
                    put("kinfolkId", "3")
                    put("amountDue", -10.0)
                    put("status", "credit")
                    put("creditAmountCents", 1000L)
                    put("client", "Old Visit")
                })
            })
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Original card not on file — only Account Balance is available.").assertIsDisplayed()
    }

    @Test
    fun accountBalance_rendersWhenPositive() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 1500L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Account Balance").assertIsDisplayed()
        onNodeWithText("\$15.00").assertIsDisplayed()
    }

    @Test
    fun redeemedCredit_showsTargetLabel() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 5000L)
            put("open", buildJsonArray {})
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {
                add(buildJsonObject {
                    put("id", "credit-done")
                    put("kinfolkId", "3")
                    put("amountDue", -50.0)
                    put("status", "credit")
                    put("creditAmountCents", 5000L)
                    put("creditTarget", "accountBalance")
                    put("creditRedeemedAtMs", 1_700_000_000_000L)
                    put("client", "Buddy")
                })
            })
        })
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Saved to Account Balance").assertIsDisplayed()
        onNodeWithText("REDEEMED").assertIsDisplayed()
    }

    @Test
    fun openInvoiceCardClick_firesOnOpenInvoice() = runComposeUiTest {
        // Detail selection is lifted into nav: tapping a card emits the id and
        // the host routes to InvoiceDetailRoute (detail render covered in
        // InvoiceDetailScreenTest).
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1001")
                    put("kinfolkId", "3")
                    put("amountDue", 120.0)
                    put("total", 120.0)
                    put("isPaid", false)
                    put("status", "open")
                    put("client", "Buddy (Nora)")
                    put("dueDate", "Sep 17, 2025")
                })
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        var opened: String? = null
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake), onOpenInvoice = { opened = it })
        }
        waitForIdle()
        onNodeWithText("Invoice #1001").performClick()
        waitForIdle()
        kotlin.test.assertEquals("1001", opened)
    }

    @Test
    fun error_rendersErrorState() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("permission-denied"))
        setThemedContent {
            InvoicesScreen("The Foster", "3", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Couldn't load invoices").assertIsDisplayed()
    }
}
