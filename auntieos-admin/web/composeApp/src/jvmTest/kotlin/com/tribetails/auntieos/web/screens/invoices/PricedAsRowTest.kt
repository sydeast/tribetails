package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.UninvoicedUnpriceable
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeUninvoicedSessionsResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1750: a visit whose stored key is not on the rate card as written is priced
 * from the one KinCare it resolves to, and the composer row says which
 * ("priced as Long walk") before the invoice is sent.
 */
@OptIn(ExperimentalTestApi::class)
class PricedAsRowTest {

    private val picks = listOf(PICK_KINFOLK, KinfolkPick("kf1", "Ada Wren"))

    private fun mount(
        result: UninvoicedSessionsResult,
        wait: String,
        check: ComposeUiTest.() -> Unit,
    ) = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-10-20",
                    onDismiss = {},
                    onConfirm = {},
                    loadUninvoiced = { _, _, _ -> WriteResult.Ok(result) },
                    setDoNotInvoice = { _, _, _ -> error("not called in this test") },
                    initialKinfolkId = "kf1",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText(wait, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        check()
    }

    private fun ComposeUiTest.pricedAsCount(): Int =
        onAllNodesWithText("priced as", substring = true, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun aResolvedKeySaysWhichKinCareItWasPricedAs() {
        val visit = UninvoicedSession(
            "s1", "kf1", "visit_60", 60.0, "2026-10-02T15:00:00.000Z", 4000L, pricedAs = "Long walk",
        )
        mount(UninvoicedSessionsResult(listOf(visit), emptyList(), emptyList(), emptyList(), true, 1, false), "$40.00") {
            onNodeWithText("priced as Long walk", useUnmergedTree = true).assertExists()
            onNodeWithText("$40.00", useUnmergedTree = true).assertExists()
        }
    }

    @Test
    fun aKeyOnTheCardAsWrittenSaysNothingAboutResolving() {
        val visit = UninvoicedSession("s1", "kf1", "60Minute", 60.0, "2026-10-02T15:00:00.000Z", 4000L)
        mount(UninvoicedSessionsResult(listOf(visit), emptyList(), emptyList(), emptyList(), true, 1, false), "$40.00") {
            assertEquals(0, pricedAsCount())
        }
    }

    @Test
    fun anUnpricedRowNeverClaimsAResolvedPrice() {
        val visit = UninvoicedSession(
            "s1", "kf1", "visit_60", 60.0, "2026-10-02T15:00:00.000Z", null, pricedAs = "Long walk",
        )
        val result = UninvoicedSessionsResult(
            listOf(visit),
            listOf(UninvoicedUnpriceable("s1", "visit_60")),
            emptyList(),
            emptyList(),
            true,
            1,
            false,
        )
        mount(result, "not on the rate card") {
            assertEquals(0, pricedAsCount())
        }
    }

    @Test
    fun decodeReadsPricedAsAndTreatsAbsentNullAndBlankAsNone() {
        val decoded = decodeUninvoicedSessionsResult(
            """
            {"sessions":[
              {"sessionId":"a","kinfolkId":"kf1","serviceType":"visit_60","durationMinutes":60,"startTime":"2026-10-02T15:00:00.000Z","unitCents":4000,"pricedAs":"Long walk"},
              {"sessionId":"b","kinfolkId":"kf1","serviceType":"60Minute","durationMinutes":60,"startTime":"2026-10-02T15:00:00.000Z","unitCents":4000,"pricedAs":null},
              {"sessionId":"c","kinfolkId":"kf1","serviceType":"60Minute","durationMinutes":60,"startTime":"2026-10-02T15:00:00.000Z","unitCents":4000},
              {"sessionId":"d","kinfolkId":"kf1","serviceType":"60Minute","durationMinutes":60,"startTime":"2026-10-02T15:00:00.000Z","unitCents":4000,"pricedAs":"  "}
            ],"unpriceable":[],"unplaceable":[],"excluded":[],"rateCardLoaded":true,"scanned":4,"truncated":false}
            """.trimIndent(),
        )
        assertEquals("Long walk", decoded.sessions[0].pricedAs)
        assertNull(decoded.sessions[1].pricedAs)
        assertNull(decoded.sessions[2].pricedAs)
        assertNull(decoded.sessions[3].pricedAs)
    }
}
