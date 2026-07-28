package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The consuming side of the Invoice State Classifier stamp (ADR-0002): stored
 * field in, affordance out. Nothing in here feeds money fields to a classifier,
 * because there is no classifier on Android anymore - the server persists
 * `status` and `editScope` in the same write that moves the money, and these
 * tests pin what each stored value renders and offers.
 */
class InvoiceActionsTest {
    private fun inv(
        status: String = "",
        editScope: String? = null,
        amountDue: Double = 0.0,
        total: Double = 0.0,
        dueDate: String = "",
    ) = Invoice(
        id = "i1",
        status = status,
        editScope = editScope,
        amountDue = amountDue,
        total = total,
        dueDate = dueDate,
    )

    // ── decoding the stored state stamp ───────────────────────────────────────

    @Test
    fun `all eight stored states decode, one for one with the server vocabulary`() {
        assertEquals(InvoiceState.QUOTE, invoiceStateOrNull(inv(status = "quote")))
        assertEquals(InvoiceState.DRAFT, invoiceStateOrNull(inv(status = "draft")))
        assertEquals(InvoiceState.CANCELLED, invoiceStateOrNull(inv(status = "cancelled")))
        assertEquals(InvoiceState.CREDIT, invoiceStateOrNull(inv(status = "credit")))
        assertEquals(InvoiceState.REDEEMED, invoiceStateOrNull(inv(status = "redeemed")))
        assertEquals(InvoiceState.PAID, invoiceStateOrNull(inv(status = "paid")))
        assertEquals(InvoiceState.ZERO, invoiceStateOrNull(inv(status = "zero")))
        assertEquals(InvoiceState.OPEN, invoiceStateOrNull(inv(status = "open")))
    }

    @Test
    fun `decode is case and whitespace tolerant, the repo's lowercase-before-compare convention`() {
        assertEquals(InvoiceState.QUOTE, invoiceStateOrNull(inv(status = " QUOTE ")))
        assertEquals(InvoiceState.DRAFT, invoiceStateOrNull(inv(status = "Draft")))
        assertEquals(InvoiceState.OPEN, invoiceStateOrNull(inv(status = " Open")))
    }

    @Test
    fun `redeemed is a first-class state - the exact drift the deleted classifier had`() {
        // The 7-state Android classifier had no REDEEMED branch at all, so a
        // credit the household had already drawn down could not render as such
        // on this platform. Stored field in, state out: no port required.
        assertEquals(InvoiceState.REDEEMED, invoiceStateOrNull(inv(status = "redeemed")))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.REDEEMED))
    }

    @Test
    fun `an absent or unrecognized status decodes to null, never to a guess`() {
        assertNull(invoiceStateOrNull(inv(status = "")))
        assertNull(invoiceStateOrNull(inv(status = "sent")))
        assertNull(invoiceStateOrNull(inv(status = "unpaid")))
    }

    @Test
    fun `the money fields cannot influence the decode - state is consumed, not derived`() {
        // Every one of these would have classified differently under the deleted
        // classifier. The stored stamp wins because the server computed it
        // against the doc as written, and second-guessing it here is how five
        // classifiers came to disagree in the first place.
        assertEquals(InvoiceState.PAID, invoiceStateOrNull(inv(status = "paid", amountDue = 40.0, total = 40.0)))
        assertEquals(InvoiceState.CREDIT, invoiceStateOrNull(inv(status = "credit", amountDue = 25.0, total = 25.0)))
        // An unlabeled doc with a live balance was OPEN under the classifier.
        // Unstamped now reads null: fail-soft, raw string, no actions.
        assertNull(invoiceStateOrNull(inv(status = "", amountDue = 40.0, total = 40.0)))
        // A negative balance was the classifier's credit signal. Without a
        // stamp it signals nothing here; the server is the one that reads money.
        assertNull(invoiceStateOrNull(inv(status = "", amountDue = -20.0, total = -20.0)))
    }

    // ── overdue ───────────────────────────────────────────────────────────────

    @Test
    fun `overdue only applies to a stored-open invoice past its due date`() {
        assertTrue(invoiceIsOverdue(inv(status = "open", dueDate = "2026-07-01"), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "open", dueDate = "2026-08-01"), "2026-07-16"))
    }

    @Test
    fun `no other stored state is ever overdue, however stale its due date`() {
        val stale = "2020-01-01"
        for (status in listOf("draft", "quote", "credit", "redeemed", "paid", "cancelled", "zero")) {
            assertFalse(status, invoiceIsOverdue(inv(status = status, dueDate = stale), "2026-07-16"))
        }
    }

    @Test
    fun `an unstamped doc is never overdue - a verdict needs a state to refine`() {
        assertFalse(invoiceIsOverdue(inv(status = "", amountDue = 40.0, dueDate = "2020-01-01"), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "sent", amountDue = 40.0, dueDate = "2020-01-01"), "2026-07-16"))
    }

    @Test
    fun `an unparseable due date never fabricates an overdue verdict`() {
        assertFalse(invoiceIsOverdue(inv(status = "open", dueDate = "Net 14"), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "open", dueDate = "07/01/2026"), "2026-07-16"))
    }

    // ── the action matrix ─────────────────────────────────────────────────────

    @Test
    fun `a paid invoice offers a receipt and nothing else (the reported bug)`() {
        assertEquals(listOf(InvoiceAction.GENERATE_RECEIPT), invoiceActionsFor(InvoiceState.PAID))
    }

    @Test
    fun `an open invoice offers the two collection actions, never a receipt`() {
        val actions = invoiceActionsFor(InvoiceState.OPEN)
        assertTrue(InvoiceAction.SEND_REMINDER in actions)
        assertTrue(InvoiceAction.RECORD_PAYMENT in actions)
        assertFalse(InvoiceAction.GENERATE_RECEIPT in actions)
        assertFalse(InvoiceAction.REVIEW_AND_SEND in actions)
    }

    @Test
    fun `a draft offers review-and-send only`() {
        assertEquals(listOf(InvoiceAction.REVIEW_AND_SEND), invoiceActionsFor(InvoiceState.DRAFT))
    }

    @Test
    fun `quote, cancelled, credit, redeemed and zero rows have no actions`() {
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.QUOTE))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.CANCELLED))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.CREDIT))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.REDEEMED))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.ZERO))
    }

    @Test
    fun `an unstamped doc is offered nothing - no affordance is fabricated`() {
        // Stored field in, affordance out, end to end: no stamp, no actions,
        // even when the money fields scream "open". The deleted classifier
        // would have offered Send reminder and Record payment here.
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(invoiceStateOrNull(inv(amountDue = 40.0, total = 40.0))))
    }

    @Test
    fun `a stored redeemed credit is offered nothing - impossible to state before the stamp`() {
        // End to end through the stored field. Before this change the string
        // "redeemed" was outside the Android vocabulary entirely: the classifier
        // read this doc's money (0/0) and called it ZERO, and a negative-money
        // variant CREDIT. Now the server's word decodes and gates directly.
        val redeemed = inv(status = "redeemed", editScope = "none")
        assertEquals(InvoiceState.REDEEMED, invoiceStateOrNull(redeemed))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(invoiceStateOrNull(redeemed)))
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(redeemed))
        assertFalse(invoiceIsOverdue(redeemed.also { it.dueDate = "2020-01-01" }, "2026-07-16"))
    }

    @Test
    fun `the matrix is total, every state and the null case resolve to a set`() {
        for (state in InvoiceState.values()) {
            assertNotNull("no action set for $state", invoiceActionsFor(state))
        }
        assertNotNull("no action set for null", invoiceActionsFor(null))
    }

    @Test
    fun `the matrix never overlaps, no state both collects and receipts`() {
        for (state in InvoiceState.values().toList() + listOf(null)) {
            val actions = invoiceActionsFor(state)
            val collecting =
                InvoiceAction.SEND_REMINDER in actions || InvoiceAction.RECORD_PAYMENT in actions
            assertFalse("$state offers both", collecting && InvoiceAction.GENERATE_RECEIPT in actions)
        }
    }

    @Test
    fun `an overdue invoice gets exactly the open set, overdue is not its own bucket`() {
        val overdueInvoice = inv(status = "open", amountDue = 40.0, total = 40.0, dueDate = "2020-01-01")
        assertTrue(invoiceIsOverdue(overdueInvoice, "2026-07-16"))
        assertEquals(
            invoiceActionsFor(InvoiceState.OPEN),
            invoiceActionsFor(invoiceStateOrNull(overdueInvoice)),
        )
    }

    @Test
    fun `a stale-dated draft cannot pick up a payment action`() {
        val staleDraft = inv(status = "draft", amountDue = 40.0, total = 40.0, dueDate = "2020-01-01")
        assertEquals(listOf(InvoiceAction.REVIEW_AND_SEND), invoiceActionsFor(invoiceStateOrNull(staleDraft)))
    }

    // ── the stored editScope ──────────────────────────────────────────────────

    @Test
    fun `the three stored edit scopes decode, case tolerant`() {
        assertEquals(InvoiceEditScope.ALL, invoiceEditScopeOf(inv(status = "open", editScope = "all")))
        assertEquals(InvoiceEditScope.METADATA_ONLY, invoiceEditScopeOf(inv(status = "open", editScope = "metadataOnly")))
        assertEquals(InvoiceEditScope.METADATA_ONLY, invoiceEditScopeOf(inv(status = "open", editScope = "METADATAONLY")))
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(inv(status = "paid", editScope = "none")))
    }

    @Test
    fun `an absent or unrecognized editScope offers no edit affordances`() {
        // The deliberate fail-soft: a doc whose editability the server has not
        // stated gets no edit affordance, and nothing recomputes the policy
        // from the money to fill the silence.
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(inv(status = "open", editScope = null)))
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(inv(status = "open", editScope = "")))
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(inv(status = "open", editScope = "everything")))
    }
}
