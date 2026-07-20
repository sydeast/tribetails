package com.tribetails.auntieos.web.screens.payments

import com.tribetails.auntieos.web.data.Payment

/**
 * Pure payment-ledger filter helpers. Extracted from the removed standalone Payments
 * screen (#11) because they are shared + unit-tested (ClientFilterHelpersTest) beyond the
 * screen itself. The screen composable + ViewModel are archived under
 * archive/removed-payments-screen/; only these reusable helpers stay in src.
 */
internal enum class PaymentMethodFilter(val label: String, val matches: (String) -> Boolean) {
    All("All", { true }),
    Cash("Cash", { it.equals("CASH", ignoreCase = true) }),
    Check("Check", { it.equals("CHECK", ignoreCase = true) }),
    Card("Card", { it.equals("CARD", ignoreCase = true) }),
    Transfer("Transfer", { it.equals("TRANSFER", ignoreCase = true) }),
}

/**
 * Client-side narrowing of the payment ledger: keeps rows matching the selected
 * payment-method tab AND (when the query is non-blank) any searchable text field.
 * Pure, so it is unit-tested directly. Touches no data layer.
 */
internal fun paymentsSearchFilter(
    payments: List<Payment>,
    query: String,
    method: PaymentMethodFilter,
): List<Payment> =
    payments
        .filter { method.matches(it.paymentMethod) }
        .filter { p ->
            query.isBlank() || listOf(
                p.kinfolkName, p.client, p.paymentMethod, p.referenceNumber, p.notes,
            ).any { it.contains(query.trim(), ignoreCase = true) }
        }
