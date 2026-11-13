package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultExcluded
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultUnplaceable
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultUnpriceable
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The un-invoiced queue on a screen: the rules that decide whether a household
 * gets billed for real work.
 *
 * The one this exists for above all: A VISIT THE RATE CARD COULD NOT PRICE
 * NEVER SHOWS $0.00. A zero there is indistinguishable from a service genuinely
 * given away, and it would ride onto the finished invoice looking deliberate.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h1920dp-xhdpi")
class UninvoicedVisitsPickerTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun session(id: String, unitCents: Long?, service: String = "Dog walk", pricedAs: String? = null) =
        ListUninvoicedSessionsResultSession(
            sessionId = id,
            kinfolkId = "kf1",
            serviceType = service,
            durationMinutes = 30.0,
            startTime = "2026-08-11T15:00:00.000Z",
            unitCents = unitCents,
            pricedAs = pricedAs,
        )

    private fun mount(
        loaded: ListUninvoicedSessionsResult,
        onOpenVisit: (String) -> Unit = {},
        onDoNotInvoice: (List<String>, Boolean, String) -> Unit = { _, _, _ -> },
        loadFailure: Throwable? = null,
        catalog: ServiceCatalog = ServiceCatalog(),
    ) {
        rule.setContent {
            AuntieOSTheme {
                val selected = remember { mutableStateOf<Set<String>>(emptySet()) }
                val prices = remember { mutableStateOf<Map<String, String>>(emptyMap()) }
                UninvoicedVisitsPicker(
                    kinfolkId = "kf1",
                    householdLabel = "Jamie Halbrook",
                    todayIso = "2026-08-19",
                    selected = selected.value,
                    onSelectedChange = { selected.value = it },
                    prices = prices.value,
                    onPriceChange = { id, text -> prices.value = prices.value + (id to text) },
                    onSessionsLoaded = {},
                    onWriteBlankInvoice = {},
                    onOpenVisit = onOpenVisit,
                    catalog = catalog,
                    load = { _, _, _ ->
                        if (loadFailure != null) Result.failure(loadFailure) else Result.success(loaded)
                    },
                    setDoNotInvoice = { ids, doNotInvoice, reason ->
                        onDoNotInvoice(ids, doNotInvoice, reason)
                        Result.success(
                            SetSessionDoNotInvoiceResult(
                                ok = true,
                                doNotInvoice = doNotInvoice,
                                changed = ids,
                                unchanged = emptyList(),
                            ),
                        )
                    },
                )
            }
        }
        rule.waitForIdle()
    }

    private fun result(
        sessions: List<ListUninvoicedSessionsResultSession>,
        unpriceable: List<ListUninvoicedSessionsResultUnpriceable> = emptyList(),
        unplaceable: List<ListUninvoicedSessionsResultUnplaceable> = emptyList(),
        rateCardLoaded: Boolean = true,
        truncated: Boolean = false,
        scanned: Long = 1L,
    ) = ListUninvoicedSessionsResult(
        sessions = sessions,
        unpriceable = unpriceable,
        unplaceable = unplaceable,
        excluded = emptyList(),
        rateCardLoaded = rateCardLoaded,
        scanned = scanned,
        truncated = truncated,
    )

    @Test
    fun `#1744 a row names the KinCare, never the stored key`() {
        // "Long walk" runs 45 minutes, so a stored `visit_45` reads as "Long walk".
        mount(
            result(listOf(session("s1", 2500L, service = "visit_45"))),
            catalog = ServiceCatalog(mapOf("Long walk" to "45"), mapOf("Long walk" to "45")),
        )
        rule.onNodeWithText("Long walk").assertExists()
        rule.onNodeWithText("visit_45").assertDoesNotExist()
    }
    @Test
    fun `a priced visit shows its price and never a field to type over it`() {
        mount(result(listOf(session("s1", 2500L))))
        rule.onNodeWithText("$25.00").assertExists()
        rule.onNodeWithText("PRICE FOR THIS VISIT ($)").assertDoesNotExist()
        // The affordance that replaces typing over the money.
        rule.onNodeWithText("Open this visit").assertExists()
    }

    @Test
    fun `a visit the rate card does not hold says so, and never shows zero`() {
        mount(
            result(
                listOf(session("s1", null)),
                unpriceable = listOf(ListUninvoicedSessionsResultUnpriceable("s1", "Dog walk")),
            ),
        )
        rule.onNodeWithText("not on the rate card").assertExists()
        rule.onNodeWithText("$0.00").assertDoesNotExist()
        // Selected by default, so the price field is already asking.
        rule.onNodeWithText("PRICE FOR THIS VISIT ($)").assertExists()
    }

    @Test
    fun `#1750 a resolved key says which KinCare it was priced as`() {
        mount(
            result(listOf(session("s1", 4500L, service = "visit_45", pricedAs = "Long walk"))),
            catalog = ServiceCatalog(mapOf("Long walk" to "45"), mapOf("Long walk" to "45")),
        )
        rule.onNodeWithText("priced as Long walk").assertExists()
        rule.onNodeWithText("$45.00").assertExists()
    }

    @Test
    fun `#1750 a key on the card as written says nothing about resolving`() {
        mount(result(listOf(session("s1", 2500L))))
        rule.onNodeWithText("$25.00").assertExists()
        rule.onNodeWithText("priced as", substring = true).assertDoesNotExist()
    }

    @Test
    fun `#1750 an unpriced row never claims a resolved price`() {
        mount(
            result(
                listOf(session("s1", null, pricedAs = "Long walk")),
                unpriceable = listOf(ListUninvoicedSessionsResultUnpriceable("s1", "Dog walk")),
            ),
        )
        rule.onNodeWithText("not on the rate card").assertExists()
        rule.onNodeWithText("priced as", substring = true).assertDoesNotExist()
    }

    @Test
    fun `no rate card at all is a settings problem with its own sentence`() {
        mount(result(listOf(session("s1", null)), rateCardLoaded = false))
        rule.onNodeWithText("No rate card").assertExists()
        rule.onNodeWithText("needs a price").assertExists()
    }

    @Test
    fun `the date range appears only when the server says the page cap was reached`() {
        mount(result(listOf(session("s1", 2500L)), truncated = true))
        rule.onNodeWithText("More visits than fit").assertExists()
        rule.onNodeWithText("VISITS FROM").assertExists()
    }

    @Test
    fun `a visit with no start time says what to fix rather than implying a wider window`() {
        mount(
            result(
                listOf(session("s1", 2500L)),
                unplaceable = listOf(ListUninvoicedSessionsResultUnplaceable("s7", "kf1")),
                scanned = 2L,
            ),
        )
        rule.onNodeWithText("Visits with no start time").assertExists()
    }

    @Test
    fun `do not invoice is armed, takes a reason, and confirms what changed`() {
        var call: Triple<List<String>, Boolean, String>? = null
        mount(
            result(listOf(session("s1", 2500L))),
            onDoNotInvoice = { ids, flag, reason -> call = Triple(ids, flag, reason) },
        )

        rule.onNodeWithText("Do not invoice this visit").performClick()
        rule.waitForIdle()
        // Armed rather than immediate: it is a decision not to charge for real
        // work, and the reason field is worth the half second it takes to read.
        rule.onNodeWithText("This visit leaves the un-invoiced list without being billed. You can put it back.")
            .assertExists()
        rule.onNodeWithText("Keep it billable").assertExists()

        rule.onNodeWithText("Do not invoice this visit").performClick()
        rule.waitForIdle()

        val made = requireNotNull(call) { "setSessionDoNotInvoice was never called" }
        assertEquals(listOf("s1"), made.first)
        assertTrue(made.second)
    }

    @Test
    fun `a failed load says what could not be done and offers the retry`() {
        mount(result(emptyList()), loadFailure = RuntimeException("permission denied"))
        rule.onNodeWithText("Couldn't load this work").assertExists()
        rule.onNodeWithText("Could not load this work: permission denied").assertExists()
        rule.onNodeWithText("Try again").assertExists()
    }

    @Test
    fun `opening a visit hands back its id`() {
        var opened: String? = null
        mount(result(listOf(session("s1", 2500L))), onOpenVisit = { opened = it })
        rule.onNodeWithText("Open this visit").performClick()
        rule.waitForIdle()
        assertEquals("s1", opened)
    }

    // ── #2089: a re-read keeps the admin's ticks ─────────────────────────────
    private val checkbox = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)
    /**
     * The picker with a list that changes between reads, the way the server's
     * does after a write. Each read takes the next result; the last one repeats.
     */
    private fun mountReads(
        reads: List<ListUninvoicedSessionsResult>,
        onDoNotInvoice: (List<String>, Boolean) -> Unit = { _, _ -> },
    ): () -> Set<String> {
        val selectedNow = mutableStateOf<Set<String>>(emptySet())
        var n = 0
        rule.setContent {
            AuntieOSTheme {
                val prices = remember { mutableStateOf<Map<String, String>>(emptyMap()) }
                UninvoicedVisitsPicker(
                    kinfolkId = "kf1",
                    householdLabel = "Jamie Halbrook",
                    todayIso = "2026-08-19",
                    selected = selectedNow.value,
                    onSelectedChange = { selectedNow.value = it },
                    prices = prices.value,
                    onPriceChange = { id, text -> prices.value = prices.value + (id to text) },
                    onSessionsLoaded = {},
                    onWriteBlankInvoice = {},
                    onOpenVisit = {},
                    load = { _, _, _ -> Result.success(reads[minOf(n++, reads.lastIndex)]) },
                    setDoNotInvoice = { ids, flag, _ ->
                        onDoNotInvoice(ids, flag)
                        Result.success(SetSessionDoNotInvoiceResult(ok = true, doNotInvoice = flag, changed = ids, unchanged = emptyList()))
                    },
                )
            }
        }
        rule.waitForIdle()
        return { selectedNow.value }
    }
    private fun excludedRow(id: String) = ListUninvoicedSessionsResultExcluded(
        sessionId = id,
        kinfolkId = "kf1",
        serviceType = "Dog walk",
        startTime = "2026-08-02T15:00:00.000Z",
        reason = "",
    )
    private val three = listOf(session("v1", 2500L), session("v2", 2500L), session("v3", 2500L))
    @Test
    fun `#2089 the first read ticks every visit`() {
        val selected = mountReads(listOf(result(three)))
        assertEquals(setOf("v1", "v2", "v3"), selected())
        rule.onNodeWithText("3 of 3 un-invoiced visits selected for Jamie Halbrook.").assertExists()
    }
    @Test
    fun `#2089 after Select none and Do not invoice on one visit the rest stay unticked and it leaves`() {
        val calls = mutableListOf<Pair<List<String>, Boolean>>()
        val selected = mountReads(
            listOf(result(three), result(three.filter { it.sessionId != "v2" })),
            onDoNotInvoice = { ids, flag -> calls += ids to flag },
        )
        rule.onNodeWithText("Select none").performClick()
        rule.waitForIdle()
        rule.onAllNodes(checkbox)[1].performClick()
        rule.waitForIdle()
        assertEquals(setOf("v2"), selected())
        rule.onNodeWithText("Do not invoice this visit").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Keep it billable").assertExists()
        rule.onNodeWithText("Do not invoice this visit").performClick()
        rule.waitForIdle()
        assertEquals(listOf(listOf("v2") to true), calls)
        assertEquals(emptySet<String>(), selected())
        rule.onNodeWithText("0 of 2 un-invoiced visits selected for Jamie Halbrook.").assertExists()
        assertEquals(2, rule.onAllNodes(checkbox).fetchSemanticsNodes().size)
        // The trap the walk found: one more press would have excluded everything.
        rule.onNodeWithText("Do not invoice").assertIsNotEnabled()
    }
    @Test
    fun `#2089 a visit put back arrives ticked and the others keep their state`() {
        val selected = mountReads(
            listOf(
                result(three).copy(excluded = listOf(excludedRow("v9"))),
                result(three + session("v9", 2500L)),
            ),
        )
        rule.onAllNodes(checkbox)[0].performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Put it back").performClick()
        rule.waitForIdle()
        assertEquals(setOf("v2", "v3", "v9"), selected())
        assertEquals(1, rule.onAllNodesWithText("3 of 4 un-invoiced visits selected for Jamie Halbrook.").fetchSemanticsNodes().size)
    }
}
