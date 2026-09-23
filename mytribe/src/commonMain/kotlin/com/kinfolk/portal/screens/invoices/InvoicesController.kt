package com.kinfolk.portal.screens.invoices

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoicesResult
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.mintCheckoutIdempotencyKey
import com.kinfolk.portal.util.formatUsd
import com.kinfolk.portal.util.openExternalUrl
import kotlinx.coroutines.launch

/**
 * PR30 deploy-skew fallback (Android and the Cloud Function don't ship
 * atomically): if `getMyHome` fails, or an old server sends no `payMethods`
 * at all, a household must still be able to pay. Stripe alone, same fallback
 * the web portal uses (`InvoiceDetail.tsx`'s `STRIPE_ONLY_FALLBACK`).
 */
private val STRIPE_ONLY_FALLBACK = listOf(
    PayMethod(id = "stripe", label = "Pay with Credit Card", kind = PayMethodKind.Checkout, url = null),
)

/**
 * ISSUE #409: which list of payment options a given bill should show.
 *
 * Three sources, in order of how much each knows:
 *
 *   1. the invoice's OWN list, resolved server-side off the options it was
 *      issued with. The only one that can be right about a bill sent before
 *      the operator changed her mind, and the only one carrying
 *      [PayMethodKind.Instructions].
 *   2. the business-wide list off `getMyHome`, for a server that predates
 *      (1). Exactly the meaning it has always had.
 *   3. Stripe alone, when neither arrived.
 *
 * NULL falls through, EMPTY does not. An empty list from (1) is a real
 * answer — a settled invoice offers nothing, an operator may have switched
 * everything off — and falling through it would put back a Pay button the
 * server deliberately withheld.
 */
internal fun payMethodsFor(invoice: Invoice, homeMethods: List<PayMethod>): List<PayMethod> =
    invoice.payMethods ?: homeMethods

/**
 * Shared invoices state holder. Both the list screen and the lifted
 * InvoiceDetailRoute destination read the same controller so the pay / redeem
 * side-effects and the post-redeem reload survive across nav destinations
 * (the detail is now a separate composable, not a child of the list).
 */
class InvoicesController internal constructor(
    private val kinfolkId: String,
    private val portalApi: PortalApi,
    private val scope: kotlinx.coroutines.CoroutineScope,
    /**
     * Every external hand-off this controller makes goes through here, so a
     * test can pass a recording fake instead of the platform opener.
     *
     * Before this parameter existed, `startPay` called `openExternalUrl`
     * directly, and the completed-checkout case in `InvoicesControllerTest`
     * handed `https://checkout.stripe.com/c/pay/cs_test_1` straight to
     * `Desktop.getDesktop().browse`, twice per `./gradlew :jvmTest`, in
     * whatever browser the person running the suite had open. Stripe refused
     * the fixture session with "This link is incomplete", which is how the
     * operator found out her unit tests were browsing the internet.
     *
     * Same shape as `SecureResetScreen`'s `openUrl`, which had it right.
     */
    private val openUrl: (String) -> Unit = { openExternalUrl(it) },
) {
    var data by mutableStateOf<InvoicesResult?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var paying by mutableStateOf<String?>(null)
        private set
    var redeeming by mutableStateOf<String?>(null)
        private set
    /** Invoice id whose quote answer is in flight (null = none), and the answer. */
    var decidingQuote by mutableStateOf<String?>(null)
        private set
    /** The server's refusal, shown on the quote panel itself rather than as a banner. */
    var quoteError by mutableStateOf<String?>(null)
        private set
    /** Which quote the refusal above belongs to, so it cannot bleed onto another one. */
    var quoteErrorInvoiceId by mutableStateOf<String?>(null)
        private set
    /** The refusal for [invoiceId], or null when the last one was about a different quote. */
    fun quoteErrorFor(invoiceId: String): String? =
        if (quoteErrorInvoiceId == invoiceId) quoteError else null
    var statusBanner by mutableStateOf<String?>(null)
        private set
    // 16.2: invoiceId currently being rendered to PDF (null = none in flight).
    var downloadingPdf by mutableStateOf<String?>(null)
        private set
    // PR30: business-level, resolved off getMyHome (never a specific
    // invoice's amountDue — same reasoning as the getMyHome.ts handler).
    // Starts as the Stripe-only fallback so the detail screen always has a
    // way to pay, even before the first reload() completes.
    //
    // ISSUE #409: this is now the FALLBACK rather than the answer. A bill
    // carries its own resolved options; see [payMethodsFor].
    var payMethods by mutableStateOf<List<PayMethod>>(STRIPE_ONLY_FALLBACK)
        private set

    fun find(invoiceId: String): Invoice? {
        val d = data ?: return null
        return (d.open + d.credits + d.paid).firstOrNull { it.id == invoiceId }
    }

    suspend fun reload() {
        try {
            data = portalApi.getMyInvoices(kinfolkId)
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load invoices"
        }
        // Independent of the invoices fetch above and never lets a payMethods
        // failure block the invoice list: a failed or empty result just
        // leaves payMethods at STRIPE_ONLY_FALLBACK.
        try {
            val home = portalApi.getMyHome(kinfolkId)
            if (home.payMethods.isNotEmpty()) payMethods = home.payMethods
        } catch (_: Throwable) {
            // Fallback already in place; nothing to surface here. The
            // Stripe-only list IS the shipped behavior on this path, not a
            // degraded one, so there is no error worth showing the household.
        }
    }

    /** 16.2: render the invoice PDF server-side and open the returned URL. */
    fun startDownloadPdf(invoice: Invoice) {
        if (downloadingPdf != null) return
        downloadingPdf = invoice.id
        scope.launch {
            try {
                val url = portalApi.getMyInvoicePdf(invoiceId = invoice.id, kinfolkId = kinfolkId)
                if (url.isNotBlank()) openUrl(url)
            } catch (t: Throwable) {
                error = t.message ?: "Could not open the invoice PDF"
            } finally {
                downloadingPdf = null
            }
        }
    }

    /**
     * WHAT THIS SCREEN GUARANTEES ABOUT DOUBLE CHARGES: LESS THAN THE WEB
     * PORTAL'S DOES (issue #826).
     *
     * `payInvoice` mints a NEW Stripe Checkout Session, with its own
     * PaymentIntent, on every call it cannot answer from an existing one. The
     * web portal's success path is `window.location.href`, which unloads the
     * page and so cannot hold two live sessions at once. For a while that
     * accident was the only thing stopping two completed checkouts becoming two
     * real charges for one bill.
     *
     * THIS SCREEN NEVER HAD EVEN THAT. `openExternalUrl` hands the URL to the
     * system browser and comes straight back; the screen stays alive, `paying`
     * is cleared in `finally`, and a second tap starts a second session. The
     * `paying != null` guard covers the round trip, not the checkout.
     *
     * So the refusal has to live on the server, and now does: `stripeWebhook`
     * compares a settling session against the invoice's own settlement round
     * and sends a second one to the household's account balance instead of
     * paying the bill twice (functions/src/lib/invoiceCheckoutDedupe.ts).
     * `payInvoice` also hands back the session this invoice already has open
     * rather than minting another, so the ordinary two-taps case reuses one
     * PaymentIntent.
     *
     * ── AND THE KEY BELOW, WHICH COVERS THE TAP NEITHER OF THOSE CAN (#825) ──
     *
     * The server's reuse can only hand back a session it can FIND, through the
     * `pendingCheckoutSessionId` it writes AFTER Stripe returns. A call that
     * never got that far stored nothing: Stripe made the session, then the
     * reply was lost on the way back and this screen showed an error for a
     * checkout that exists. The next tap finds nothing to reuse and opens a
     * second one. The key is what closes that, inside Stripe, before a second
     * session exists.
     *
     * ONE KEY PER INVOICE, held across a re-tap, kept in a map rather than a
     * single field: a household with two open bills can tap one, fail, and tap
     * the other, and one held key would carry the first invoice's key to the
     * second invoice's checkout.
     *
     * Dropped the moment a checkout URL comes back, so the only tap that reuses
     * a key is a tap after a visible failure. `CheckoutIdempotency.kt` says why
     * a second session is money this business cannot get back.
     */
    private val checkoutKeys = mutableMapOf<String, String>()

    fun startPay(invoice: Invoice) {
        if (paying != null) return
        paying = invoice.id
        scope.launch {
            try {
                val key = checkoutKeys.getOrPut(invoice.id) { mintCheckoutIdempotencyKey() }
                val res = portalApi.payInvoice(
                    invoiceId = invoice.id,
                    kinfolkId = kinfolkId,
                    successUrl = "https://kinfolk.tribetails.com/portal/payment-success",
                    cancelUrl = "https://kinfolk.tribetails.com/portal/payment-cancel",
                    idempotencyKey = key,
                )
                // Dropped BEFORE the hand-off. A household that comes back to
                // pay a different balance later must not reuse a key Stripe
                // still holds: the body would differ and Stripe would refuse it.
                checkoutKeys.remove(invoice.id)
                if (res.checkoutUrl.isNotBlank()) openUrl(res.checkoutUrl)
            } catch (t: Throwable) {
                error = t.message ?: "Could not start payment"
            } finally {
                paying = null
            }
        }
    }

    /**
     * PR30: dispatches on [PayMethod.kind]. Checkout (Stripe, and the
     * Klarna/Affirm rails riding it) reuses [startPay] unchanged; Link
     * (Venmo/PayPal/Cash App) is a plain external navigation, same as
     * [startDownloadPdf]'s `openExternalUrl` — no callable round-trip,
     * because the resolved URL already came back with the invoice payload.
     */
    fun startPayMethod(invoice: Invoice, method: PayMethod) {
        when (method.kind) {
            PayMethodKind.Checkout -> startPay(invoice)
            PayMethodKind.Link -> method.url?.takeIf { it.isNotBlank() }?.let { openUrl(it) }
            // ISSUE #409: an instructions method is text, not a target. The
            // screen renders it without a tap handler, so this branch exists
            // to state that there is nothing to do rather than to be reached.
            PayMethodKind.Instructions -> Unit
        }
    }

    /**
     * THE HOUSEHOLD'S ANSWER TO A QUOTE (issue #385).
     *
     * One entry point for both answers, so two taps cannot be in flight at
     * once, and always followed by a reload: accepting re-stamps the doc as an
     * open bill server-side, and the screens read this controller's copy.
     *
     * The failure is kept as [quoteError] rather than folded into [error]: the
     * refusals here are sentences about THIS quote ("already declined", "only
     * good through the 12th") and belong beside the buttons that caused them.
     */
    fun startQuoteDecision(invoice: Invoice, accept: Boolean) {
        if (decidingQuote != null) return
        decidingQuote = invoice.id
        quoteError = null
        quoteErrorInvoiceId = null
        statusBanner = null
        scope.launch {
            try {
                if (accept) {
                    portalApi.acceptQuote(invoiceId = invoice.id, kinfolkId = kinfolkId)
                    statusBanner = "Quote accepted. It is an invoice now."
                } else {
                    portalApi.denyQuote(invoiceId = invoice.id, kinfolkId = kinfolkId)
                    statusBanner = "Quote declined. Your Auntie has been told."
                }
                reload()
            } catch (t: Throwable) {
                quoteError = t.message ?: "Could not send your answer"
                quoteErrorInvoiceId = invoice.id
            } finally {
                decidingQuote = null
            }
        }
    }
    fun startRedeem(invoice: Invoice, target: CreditTarget) {
        if (redeeming != null) return
        redeeming = invoice.id
        statusBanner = null
        scope.launch {
            try {
                val res = portalApi.redeemCredit(
                    invoiceId = invoice.id,
                    kinfolkId = kinfolkId,
                    target = target,
                )
                statusBanner = when (target) {
                    CreditTarget.AccountBalance -> "Saved ${formatCents(res.redeemedAmountCents)} to your account balance."
                    CreditTarget.OriginalPaymentMethod -> "Refunded ${formatCents(res.redeemedAmountCents)} to your original card."
                }
                reload()
            } catch (t: Throwable) {
                statusBanner = "Couldn't redeem: ${t.message ?: t}"
            } finally {
                redeeming = null
            }
        }
    }
}

@Composable
fun rememberInvoicesController(kinfolkId: String, portalApi: PortalApi): InvoicesController {
    val scope = rememberCoroutineScope()
    return remember(kinfolkId, portalApi) { InvoicesController(kinfolkId, portalApi, scope) }
}

private fun formatCents(cents: Long): String = formatUsd(cents.toDouble() / 100.0)
