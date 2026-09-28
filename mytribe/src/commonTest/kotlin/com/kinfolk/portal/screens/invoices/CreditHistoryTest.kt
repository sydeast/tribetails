package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.CreditApplication
import com.kinfolk.portal.portal.CreditUse
import com.kinfolk.portal.portal.GivenCredit
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Q6 (operator ruling 2026-09-27): the portal's account credit history.
 * Billing people see each credit, its date, its reason and the date it was
 * applied. Everyone else sees nothing, and a failure never costs the invoices.
 */
class CreditHistoryTest {

    private val utc = TimeZone.UTC

    // 2026-09-12T15:00:00Z and 2026-09-27T15:00:00Z
    private val sep12 = 1_789_225_200_000L
    private val sep27 = 1_790_521_200_000L

    private fun historyJson(): JsonObject = buildJsonObject {
        put("ok", true)
        put("kinfolkId", "kin-1")
        put("accountBalanceCents", 1000)
        put("credits", buildJsonArray {
            add(buildJsonObject {
                put("creditId", "crd_2")
                put("amountCents", 1000)
                put("reason", "Goodwill")
                put("givenAtMs", sep27)
                put("remainingCents", 1000)
                put("fullyAppliedAtMs", JsonNull)
                put("applications", buildJsonArray {})
                put("someFutureField", "ignored")
            })
            add(buildJsonObject {
                put("creditId", "crd_1")
                put("amountCents", 2500)
                put("reason", "Missed visit")
                put("givenAtMs", sep12)
                put("remainingCents", 0)
                put("fullyAppliedAtMs", sep27)
                put("applications", buildJsonArray {
                    add(buildJsonObject {
                        put("appliedAtMs", sep27)
                        put("amountCents", 2500)
                        put("invoiceId", "inv9")
                        put("invoiceNumber", "INV-1009")
                    })
                })
            })
        })
        put("uses", buildJsonArray {
            add(buildJsonObject {
                put("useId", "draw_p1")
                put("usedAtMs", sep27)
                put("amountCents", 2500)
                put("invoiceId", "inv9")
                put("invoiceNumber", "INV-1009")
            })
        })
    }

    private fun invoicesJson(): JsonObject = buildJsonObject {
        put("open", buildJsonArray {})
        put("paid", buildJsonArray {})
        put("credits", buildJsonArray {})
        put("accountBalanceCents", 1000)
    }

    // ---- PortalApi ----

    @Test
    fun `calls getAccountCreditHistory with the household id and decodes every field`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getAccountCreditHistory", historyJson())
        val h = PortalApi(fake).getAccountCreditHistory("kin-1")

        assertEquals("getAccountCreditHistory", fake.calls.single().first)
        assertEquals("kin-1", fake.calls.single().second?.get("kinfolkId")?.jsonPrimitive?.content)
        assertEquals(1000L, h.accountBalanceCents)
        assertEquals(listOf("crd_2", "crd_1"), h.credits.map { it.creditId })
        val used = h.credits[1]
        assertEquals(sep27, used.fullyAppliedAtMs)
        assertEquals("Missed visit", used.reason)
        assertEquals(listOf(CreditApplication(sep27, 2500, "inv9", "INV-1009")), used.applications)
        assertNull(h.credits[0].fullyAppliedAtMs)
        assertEquals(listOf(CreditUse("draw_p1", sep27, 2500, "inv9", "INV-1009")), h.uses)
    }

    @Test
    fun `decodes an empty history`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getAccountCreditHistory", buildJsonObject {
            put("ok", true); put("kinfolkId", "kin-1"); put("accountBalanceCents", 0)
            put("credits", buildJsonArray {}); put("uses", buildJsonArray {})
        })
        val h = PortalApi(fake).getAccountCreditHistory("kin-1")
        assertTrue(h.credits.isEmpty() && h.uses.isEmpty())
    }

    // ---- Controller ----

    @Test
    fun `reload loads the history beside the invoices`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", invoicesJson())
        fake.stub("getAccountCreditHistory", historyJson())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.reload()

        assertNotNull(c.data)
        val state = assertIs<CreditHistoryState.Ready>(c.creditHistory)
        assertEquals(2, state.history.credits.size)
    }

    @Test
    fun `permission-denied hides the section and the invoices still load`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", invoicesJson())
        fake.stubError("getAccountCreditHistory", IllegalStateException("permission-denied"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.reload()

        assertEquals(CreditHistoryState.Hidden, c.creditHistory)
        assertNotNull(c.data)
        assertNull(c.error)
    }

    @Test
    fun `the server's own billing refusal sentence also hides it`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", invoicesJson())
        fake.stubError(
            "getAccountCreditHistory",
            IllegalStateException("Billing access is required to see account credit."),
        )
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}
        c.reload()
        assertEquals(CreditHistoryState.Hidden, c.creditHistory)
    }

    @Test
    fun `any other failure shows the inline message and leaves the invoices alone`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", invoicesJson())
        fake.stubError("getAccountCreditHistory", IllegalStateException("deadline-exceeded"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.reload()

        assertEquals(CreditHistoryState.Failed, c.creditHistory)
        assertNotNull(c.data)
        assertNull(c.error)
    }

    @Test
    fun `an empty history hides the section`() {
        val empty = com.kinfolk.portal.portal.CreditHistoryResult("kin-1", 0, emptyList(), emptyList())
        assertEquals(CreditHistoryState.Hidden, creditHistoryStateOf(Result.success(empty)))
    }

    // ---- Row text ----

    private fun credit(
        amount: Long = 5000,
        remaining: Long = 5000,
        fully: Long? = null,
        apps: List<CreditApplication> = emptyList(),
    ) = GivenCredit("crd_1", amount, "Goodwill", sep12, remaining, fully, apps)

    @Test
    fun `given line carries the date`() {
        assertEquals("Given Sep 12, 2026", creditGivenLine(credit(), utc))
    }

    @Test
    fun `an unused credit reads Not used yet`() {
        assertEquals("Not used yet", creditStatusLine(credit(), utc))
    }

    @Test
    fun `a fully used credit reads Applied with the date`() {
        val c = credit(remaining = 0, fully = sep27, apps = listOf(CreditApplication(sep27, 5000, "inv9", "INV-1009")))
        assertEquals("Applied Sep 27, 2026", creditStatusLine(c, utc))
    }

    @Test
    fun `a partly used credit reads how much and when`() {
        val c = credit(
            remaining = 2000,
            apps = listOf(
                CreditApplication(sep12, 1000, "inv1", "INV-1"),
                CreditApplication(sep27, 2000, "inv2", null),
            ),
        )
        assertEquals("$30.00 of $50.00 applied (Sep 12, 2026; Sep 27, 2026)", creditStatusLine(c, utc))
    }

    @Test
    fun `a use names its invoice, or says an invoice when it has no number`() {
        assertEquals("$25.00 on INV-1009, Sep 27, 2026", creditUseLine(CreditUse("u1", sep27, 2500, "inv9", "INV-1009"), utc))
        assertEquals("$25.00 on an invoice, Sep 27, 2026", creditUseLine(CreditUse("u1", sep27, 2500, "inv9", null), utc))
    }
}
