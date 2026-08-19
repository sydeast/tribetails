package com.kinfolk.portal.portal

/**
 * PR30: one configured payment processor, resolved (url + label) off
 * `getMyHome`'s `payMethods` — never a raw operator handle (the server
 * already stripped those in `resolvePayMethods`). [Checkout] is the existing
 * Stripe `payInvoice` flow; [Link] is opened via `openExternalUrl`,
 * mirroring how `InvoicesController.startDownloadPdf` already opens an
 * external URL.
 *
 * NEVER carries a processor fee — kinfolk never see fees (standing ruling);
 * see `mytribe/functions/src/lib/paymentMethods.ts`.
 */
enum class PayMethodKind { Checkout, Link }

data class PayMethod(
    val id: String,
    val label: String,
    val kind: PayMethodKind,
    val url: String?,
)

/**
 * `Quote` joined the enum with the accept/decline surface (issue #385). Before
 * it, `decodeInvoice` fell through to `Open` for a quote, so the Android portal
 * showed a proposal as a pending bill with a Pay button on it: the same defect
 * the web portal fixed when the stamped states landed.
 *
 * Still not the server's full eight-state vocabulary: `zero` and `redeemed`
 * have no surface here yet and keep their existing fallbacks.
 */
enum class InvoiceStatus { Draft, Quote, Open, Paid, Credit, Cancelled }
/** What the household said about a quote. Null until they have answered. */
enum class QuoteDecision { Accepted, Denied }

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
    /** The household's answer to this quote, or null while it still waits for one. */
    val quoteDecision: QuoteDecision? = null,
    /** When that answer was given, epoch millis. */
    val quoteDecidedAtMs: Long? = null,
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

/**
 * The result of `acceptQuote` / `denyQuote`.
 *
 * `status` is the state the server stamped as it recorded the answer: `Open`
 * after an acceptance (it is a bill now), `Quote` after a decline (still not a
 * bill, but answered). The controller reloads either way, so this is here to
 * be asserted on rather than to drive a screen.
 */
data class QuoteDecisionResult(
    val ok: Boolean,
    val invoiceId: String,
    val status: InvoiceStatus,
)
