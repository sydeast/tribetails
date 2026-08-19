package com.kinfolk.portal.portal

/**
 * PR30: one configured payment option, resolved (url + label) server-side —
 * never a raw operator handle (`resolvePayMethods` already stripped those).
 * [Checkout] is the existing Stripe `payInvoice` flow, which now also covers
 * the Klarna and Affirm rails riding that same account; [Link] is opened via
 * `openExternalUrl`, mirroring how `InvoicesController.startDownloadPdf`
 * already opens an external URL.
 *
 * ISSUE #409 adds [Instructions]: a method with no URL and never any, where
 * the operator's own words are the whole thing. Cash, a check, a bank
 * transfer and Zelle-by-phone all land here. It is NOT tappable, so nothing
 * about it can become a dead link.
 *
 * NEVER carries a processor fee — kinfolk never see fees (standing ruling);
 * see `mytribe/functions/src/lib/paymentMethods.ts`.
 */
enum class PayMethodKind { Checkout, Link, Instructions }

data class PayMethod(
    val id: String,
    val label: String,
    val kind: PayMethodKind,
    val url: String?,
    /**
     * Set only on [PayMethodKind.Instructions], and never blank: the server
     * omits a method it has no instructions for rather than sending an empty
     * one. Null on the other two kinds.
     *
     * Defaulted so every existing construction of this class — the tests and
     * the deploy-skew fallback among them — keeps compiling unchanged.
     */
    val instructions: String? = null,
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
    /**
     * ISSUE #409: how THIS bill can be paid, resolved server-side off the
     * payment options it was issued with.
     *
     * Prefer this over `MyHomeResult.payMethods`: the home list is
     * business-wide, cannot know what a bill sent last month was issued with,
     * and never carries [PayMethodKind.Instructions].
     *
     * Null from a server older than the field, which is a different statement
     * from an empty list (a settled invoice offers nothing). The controller
     * falls back to the home list on null and NOT on empty.
     */
    val payMethods: List<PayMethod>? = null,
)

/** One covered visit on an invoice. All fields optional server-side. */
data class InvoiceLineItem(
    /** The visit this line bills for, or null/'' on a line typed by hand (#408). */
    val sessionId: String?,
    val label: String?,
    /**
     * The day the work happened, ISO-8601. Carried by a line drawn from a
     * visit, read LIVE off that visit by the server, so a corrected visit time
     * corrects this too. Null on a line with no visit behind it, which has no
     * date to state.
     */
    val dateIso: String?,
    val amountCents: Long?,
    /**
     * How many units this line bills, and what each one cost. Present on the
     * invoice's OWN lines; null on a row rebuilt from a visit, which knows only
     * its total.
     *
     * Decoded so the household can check the arithmetic: a line billed 3 x $20
     * that reads as a bare $60 shows a figure with no working, which is the one
     * thing a person receiving a bill most wants to see. The web portal has
     * shown it since the stored lines landed.
     */
    val qty: Double?,
    val unitCents: Long?,
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
