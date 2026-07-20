package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Payment
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper tests for the payment-ledger search + method-filter pipeline
 * ([paymentsSearchFilter]). Mirrors the web `paymentsSearchFilter` name/behavior:
 * method tab keeps matching rows, a non-blank query matches any searchable text
 * field, and the two narrow together.
 */
class PaymentsSearchFilterTest {

    private fun payment(
        id: String,
        kinfolkName: String = "",
        client: String = "",
        method: String = "CASH",
        reference: String = "",
        notes: String = "",
    ) = Payment(
        id = id,
        kinfolkName = kinfolkName,
        client = client,
        paymentMethod = method,
        referenceNumber = reference,
        notes = notes,
    )

    private val ledger = listOf(
        payment("a", kinfolkName = "Jane Doe", method = "CASH", reference = "R-100"),
        payment("b", kinfolkName = "John Smith", method = "CARD", notes = "tip included"),
        payment("c", client = "Acme Household", method = "CHECK", reference = "CHK-7"),
        payment("d", kinfolkName = "Jane Roe", method = "TRANSFER", notes = "wire from bank"),
    )

    @Test
    fun allFilterNoQueryReturnsEverything() {
        val out = paymentsSearchFilter(ledger, "", PaymentMethodFilter.All)
        assertEquals(listOf("a", "b", "c", "d"), out.map { it.id })
    }

    @Test
    fun methodFilterKeepsOnlyThatMethod() {
        val out = paymentsSearchFilter(ledger, "", PaymentMethodFilter.Card)
        assertEquals(listOf("b"), out.map { it.id })
    }

    @Test
    fun methodFilterIsCaseInsensitive() {
        val lower = listOf(payment("x", method = "card"))
        val out = paymentsSearchFilter(lower, "", PaymentMethodFilter.Card)
        assertEquals(listOf("x"), out.map { it.id })
    }

    @Test
    fun queryMatchesKinfolkName() {
        val out = paymentsSearchFilter(ledger, "jane", PaymentMethodFilter.All)
        assertEquals(listOf("a", "d"), out.map { it.id })
    }

    @Test
    fun queryMatchesClient() {
        val out = paymentsSearchFilter(ledger, "acme", PaymentMethodFilter.All)
        assertEquals(listOf("c"), out.map { it.id })
    }

    @Test
    fun queryMatchesReferenceNumber() {
        val out = paymentsSearchFilter(ledger, "chk-7", PaymentMethodFilter.All)
        assertEquals(listOf("c"), out.map { it.id })
    }

    @Test
    fun queryMatchesNotes() {
        val out = paymentsSearchFilter(ledger, "wire", PaymentMethodFilter.All)
        assertEquals(listOf("d"), out.map { it.id })
    }

    @Test
    fun queryMatchesPaymentMethodText() {
        val out = paymentsSearchFilter(ledger, "transfer", PaymentMethodFilter.All)
        assertEquals(listOf("d"), out.map { it.id })
    }

    @Test
    fun queryIsTrimmedAndCaseInsensitive() {
        val out = paymentsSearchFilter(ledger, "  JANE  ", PaymentMethodFilter.All)
        assertEquals(listOf("a", "d"), out.map { it.id })
    }

    @Test
    fun combinedMethodAndQueryNarrowTogether() {
        // "jane" matches a (CASH) + d (TRANSFER); the CASH tab keeps only a.
        val out = paymentsSearchFilter(ledger, "jane", PaymentMethodFilter.Cash)
        assertEquals(listOf("a"), out.map { it.id })
    }

    @Test
    fun noMatchReturnsEmpty() {
        val out = paymentsSearchFilter(ledger, "nonexistent", PaymentMethodFilter.All)
        assertEquals(emptyList<String>(), out.map { it.id })
    }
}
