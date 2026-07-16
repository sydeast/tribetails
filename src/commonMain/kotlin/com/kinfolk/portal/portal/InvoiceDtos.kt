package com.kinfolk.portal.portal

enum class InvoiceStatus { Draft, Open, Paid, Credit, Cancelled }

enum class CreditTarget { AccountBalance, OriginalPaymentMethod }

data class Invoice(
    val id: String,
    val kinfolkId: String,
    val kinfolkName: String?,
    val client: String?,
    val total: Double,
    val amountDue: Double,
    val isPaid: Boolean,
    val status: InvoiceStatus,
    val date: String?,
    val dueDate: String?,
    val discount: String?,
    val terms: String?,
    val paymentsHistory: String?,
    val address: String?,
    val viewed: Boolean,
    val creditAmountCents: Long?,
    val creditTarget: CreditTarget?,
    val creditRedeemedAtMs: Long?,
    val originalPaymentIntentId: String?,
    /** Optional per-visit breakdown ("What this covers" on the detail screen).
     *  Null/empty until the backend ships the field — decode is lenient, so a
     *  missing or malformed payload simply yields null. */
    val lineItems: List<InvoiceLineItem>? = null,
)

/** One covered visit on an invoice. All fields optional server-side. */
data class InvoiceLineItem(
    val sessionId: String?,
    val label: String?,
    val dateIso: String?,
    val amountCents: Long?,
)

data class InvoicesResult(
    val open: List<Invoice>,
    val paid: List<Invoice>,
    val credits: List<Invoice>,
    val accountBalanceCents: Long,
)

data class RedeemCreditResult(
    val ok: Boolean,
    val redeemedAmountCents: Long,
    val target: CreditTarget,
    val newAccountBalanceCents: Long?,
    val refundId: String?,
)
