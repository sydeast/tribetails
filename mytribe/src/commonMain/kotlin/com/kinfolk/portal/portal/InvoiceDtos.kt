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
 * The stored Invoice State Stamp (ADR-0002), all eight states of it.
 *
 * `Quote` joined the enum with the accept/decline surface (issue #385). Before
 * it, `decodeInvoice` fell through to `Open` for a quote, so the Android portal
 * showed a proposal as a pending bill with a Pay button on it: the same defect
 * the web portal fixed when the stamped states landed.
 *
 * `Zero` and `Redeemed` are the last two to arrive (issue #449), and the
 * fallback they were left on was that same defect waiting its turn. A
 * `redeemed` invoice read as `Open`, and a redeemed credit can carry a positive
 * `amountDue` (`functions/src/lib/invoiceEditPolicy.ts` says so in as many
 * words), so a spent credit could be shown to a household with a Pay button
 * on it. A `zero` invoice read as `Open` as well, which captioned a $0 bill
 * "PENDING" and offered to collect nothing.
 *
 * The server sends nothing outside this list: `getMyInvoices` validates
 * `status` against the same eight-state enum before it answers.
 */
enum class InvoiceStatus { Draft, Quote, Open, Zero, Paid, Credit, Redeemed, Cancelled }
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
