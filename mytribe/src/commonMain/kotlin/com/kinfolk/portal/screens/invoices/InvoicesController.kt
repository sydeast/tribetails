package com.kinfolk.portal.screens.invoices

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalWindowInfo
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.InvoicesResult
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.mintCheckoutIdempotencyKey
import com.kinfolk.portal.util.attempt
import com.kinfolk.portal.util.formatUsd
import com.kinfolk.portal.util.openExternalUrl
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
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
 * #2366, #2401: WHERE STRIPE SENDS THE HOUSEHOLD BACK TO. An address on the
 * MyTribe web portal's origin that THIS APP claims, `/app/invoices/{id}`: the
 * marker on success, the bare address on cancel. The server only accepts a
 * return address on the portal's own origins (`requirePortalReturnUrls`), so
 * it is an https address there and never the app's own scheme.
 *
 * The phone opens this app on that invoice ([checkoutReturnFromLink],
 * [InvoicesController.onCheckoutReturn]). When the browser keeps the page, the
 * web portal shows a signed-out page there that points back to this app
 * (`AppCheckoutReturn.tsx`).
 *
 * History, because the server still has to accept all three. Before #2366 this
 * app sent `/portal/payment-success`, a page the portal does not have. #2366
 * sent the web portal's own `/invoices/{id}`, which needs a web sign-in a
 * household who lives in this app has usually never done in that browser
 * (#2401). Builds from both eras are still installed and must still pay.
 */
internal const val PORTAL_ORIGIN = "https://$APP_RETURN_HOST"
internal fun checkoutReturnUrls(invoiceId: String): Pair<String, String> {
    val page = "$PORTAL_ORIGIN/app/invoices/${encodePathSegment(invoiceId)}"
    return "$page?$CHECKOUT_RETURN_PARAM=$CHECKOUT_RETURN_DONE" to page
}
/** Percent-encodes everything outside RFC 3986's unreserved set, as `encodeURIComponent` does for a path. */
internal fun encodePathSegment(raw: String): String = buildString {
    for (b in raw.encodeToByteArray()) {
        val c = b.toInt() and 0xFF
        val ch = c.toChar()
        if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
            append(ch)
        } else {
            append('%')
            append("0123456789ABCDEF"[c shr 4])
            append("0123456789ABCDEF"[c and 0x0F])
        }
    }
}
/** How often the bill is read again while checking a payment, and for how long. Same figures as the web portal. */
internal const val PAYMENT_CHECK_EVERY_MS = 3_000L
internal const val PAYMENT_CHECK_FOR_MS = 60_000L

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
    /**
     * #2366: the invoice whose payment is being checked after the household
     * came back from Stripe, or null. While it is set the screens hold Pay back
     * and say "Checking payment…": the webhook decides paid, and it can land
     * seconds after the household is back.
     */
    var checkingPayment by mutableStateOf<String?>(null)
        private set
    /** #2366: the invoice whose check ran out with the bill still owed, or null. */
    var paymentNotSeen by mutableStateOf<String?>(null)
        private set
    /**
     * #2402: the invoice whose check ran out with NO read getting through, or
     * null. Nothing is known about the payment, so the screens keep Pay held
     * back and offer Check again: a second payment would be a second real
     * charge, and there are no refunds. Cleared by the next read that works.
     */
    var paymentNotChecked by mutableStateOf<String?>(null)
        private set
    /** The invoice handed to Stripe and not yet checked. Set on hand-off, spent on return. */
    private var awaitingCheckout: String? = null
    private var checkJob: Job? = null
    private var checkToken: Any? = null
    /** True while the running check was started by focus coming back and by nothing surer. See [onCheckoutReturn]. */
    private var checkStartedByFocus = false

    /**
     * Q6: the account credit history. Loaded beside the invoices and never
     * allowed to break them: a refusal (no billing access) hides the section,
     * any other failure shows one line in it.
     */
    var creditHistory by mutableStateOf<CreditHistoryState>(CreditHistoryState.Loading)
        private set

    fun find(invoiceId: String): Invoice? {
        val d = data ?: return null
        return (d.open + d.credits + d.paid).firstOrNull { it.id == invoiceId }
    }

    // #1282: the three reads start together and are applied in the old order.
    // They used to be awaited one after the other, and getMyInvoices and
    // getAccountCreditHistory carry no minInstances, so a first open paid two
    // cold starts in a row.
    suspend fun reload() {
        read(quietFailure = false)
    }

    /**
     * One read of the invoices, the pay methods and the credit history.
     * Answers whether the INVOICES were read.
     *
     * [quietFailure] is the payment check's read (#2402). The check reads every
     * few seconds on a phone that has just come back from Stripe, and a read
     * that did not get through there must not replace a list the household
     * already has with "Couldn't load invoices": the check has its own cue and
     * tries again on the next tick. With nothing loaded yet the failure is
     * still reported, because there is nothing else to show.
     */
    private suspend fun read(quietFailure: Boolean): Boolean = coroutineScope {
        val invoicesFetch = async { attempt { portalApi.getMyInvoices(kinfolkId) } }
        val homeFetch = async { attempt { portalApi.getMyHome(kinfolkId) } }
        val creditFetch = async { attempt { portalApi.getAccountCreditHistory(kinfolkId) } }
        val invoicesRead = try {
            data = invoicesFetch.await().getOrThrow()
            error = null
            true
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            if (!quietFailure || data == null) error = t.message ?: "Could not load invoices"
            false
        }
        if (invoicesRead) settleUncheckedPayment()
        // Independent of the invoices fetch above and never lets a payMethods
        // failure block the invoice list: a failed or empty result just
        // leaves payMethods at STRIPE_ONLY_FALLBACK.
        try {
            val home = homeFetch.await().getOrThrow()
            if (home.payMethods.isNotEmpty()) payMethods = home.payMethods
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            // Fallback already in place; nothing to surface here. The
            // Stripe-only list IS the shipped behavior on this path, not a
            // degraded one, so there is no error worth showing the household.
        }
        creditHistory = creditHistoryStateOf(creditFetch.await())
        invoicesRead
    }

    /**
     * #2402: a read has got through after a check gave up with nothing read.
     * The bill is known again: paid is said, and a bill still owed gets the
     * ordinary "has not shown up" line, with Pay offered beside it.
     */
    private fun settleUncheckedPayment() {
        val invoiceId = paymentNotChecked ?: return
        paymentNotChecked = null
        val invoice = find(invoiceId) ?: return
        if (offersPayment(invoice)) {
            paymentNotSeen = invoiceId
        } else if (invoice.isPaid || invoice.status == InvoiceStatus.Paid) {
            statusBanner = PAYMENT_RECEIVED
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
            } catch (c: CancellationException) {
                throw c
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
        // A PAID INVOICE TAKES NO PAYMENT (docket Q5). The screens already hide
        // the button; this is for a stale screen or a caller that skips them.
        // The server refuses too (`payInvoice`), with the same sentence.
        if (!offersPayment(invoice)) {
            if (invoice.isPaid || invoice.status == InvoiceStatus.Paid) error = PAID_INVOICE_REFUSAL
            // #2410: the server's own sentence for a bill that cannot take a payment.
            payBlockedReason(invoice)?.let { error = it }
            return
        }
        // #2366, #2402: Pay is held back while a payment just made is being
        // checked, and after a check that could not read the bill at all. The
        // screens already hide the button; this is the same rule for a caller
        // that skips them.
        if (checkingPayment == invoice.id || paymentNotChecked == invoice.id) return
        paying = invoice.id
        scope.launch {
            try {
                val key = checkoutKeys.getOrPut(invoice.id) { mintCheckoutIdempotencyKey() }
                val (successUrl, cancelUrl) = checkoutReturnUrls(invoice.id)
                val res = portalApi.payInvoice(
                    invoiceId = invoice.id,
                    kinfolkId = kinfolkId,
                    successUrl = successUrl,
                    cancelUrl = cancelUrl,
                    idempotencyKey = key,
                )
                // Dropped BEFORE the hand-off. A household that comes back to
                // pay a different balance later must not reuse a key Stripe
                // still holds: the body would differ and Stripe would refuse it.
                checkoutKeys.remove(invoice.id)
                if (res.checkoutUrl.isNotBlank()) {
                    // #2366: set BEFORE the hand-off, so the return to this
                    // app (window focus coming back) finds it.
                    awaitingCheckout = invoice.id
                    // #2401: and whatever an earlier return link said about
                    // this invoice does not answer for this checkout.
                    PendingCheckoutReturn.handedOff(invoice.id)
                    paymentNotSeen = null
                    openUrl(res.checkoutUrl)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                error = t.message ?: "Could not start payment"
            } finally {
                paying = null
            }
        }
    }

    /**
     * #2366: THE HOUSEHOLD IS BACK FROM THE BROWSER. Called whenever this app's
     * window gets focus again; does nothing unless a checkout was handed off.
     *
     * This app cannot see which of Stripe's two addresses the browser opened,
     * so it cannot tell a finished payment from a cancelled one. It checks: it
     * reads the bill again until the read shows it settled, and if that has
     * not happened inside [PAYMENT_CHECK_FOR_MS] it stops, says the payment has
     * not shown up, and offers Pay again. It never says paid on its own.
     *
     * #2401: this is the fallback now. The return link normally brings the
     * household back ([onCheckoutReturn]), and it DOES say which address the
     * browser opened. So when a link for this invoice is waiting to be opened,
     * this stands down and the link decides. Focus alone is what is left when
     * the household closes the browser and switches back by hand.
     *
     * One more case: Android opened the link in a second window of this app,
     * and the household has now backed out to this one, which still remembers
     * the hand-off. If that link said the checkout was cancelled, nothing is
     * checked here either. If it said finished, or said nothing, this window
     * checks for itself: the other window's check ended with that window, and
     * a bill that may still be landing is never shown with a live Pay button.
     */
    fun onAppReturned() {
        val invoiceId = awaitingCheckout ?: return
        if (PendingCheckoutReturn.isWaitingFor(invoiceId)) return
        awaitingCheckout = null
        if (PendingCheckoutReturn.wasCancelled(invoiceId)) {
            // No payment was made. Show the bill as it stands.
            scope.launch { read(quietFailure = true) }
            return
        }
        startPaymentCheck(invoiceId, byFocus = true)
    }

    /**
     * #2401: THE RETURN LINK OPENED THIS APP. Works by itself: Android may
     * have ended this app while the household was at Stripe, and then nothing
     * here remembers the hand-off, so the invoice and the outcome both come
     * from the link ([checkoutReturnFromLink]).
     *
     * A FINISHED checkout starts the check, unless one is already running for
     * this invoice.
     *
     * A CANCELLED checkout starts none, and calls off a check that only focus
     * coming back had started: no payment was made, so there is nothing to
     * wait for, and Pay is offered again at once instead of after a minute. The
     * bill is read once so the screen shows it as it stands.
     *
     * WHAT A LINK MAY AND MAY NOT DO. Any app or web page can fire one. It
     * never says paid: the read does. And a cancelled link is believed only
     * while nothing better is known. It cannot stop a check that a finished
     * link started or confirmed, or one the household asked for with Check
     * again, so a forged or stale cancel cannot put a live Pay button in front
     * of a payment that is still landing. The one wait it can end is the one
     * that began on a guess, focus coming back.
     *
     * NOR MAY A LINK TAKE THE HOLD OFF ANOTHER BILL. There is one check at a
     * time, and a new one replaces the one running. A finished link naming any
     * other id (it needs no real one) used to do exactly that, and Pay came
     * back on the bill whose payment was still landing. So a finished link
     * replaces a check running on another invoice only when THIS window handed
     * that link's invoice to Stripe, which no link can fake: it takes a tap on
     * Pay here. Any other link for another invoice costs one read.
     */
    fun onCheckoutReturn(ret: CheckoutReturn) {
        val handedOffHere = awaitingCheckout == ret.invoiceId
        if (handedOffHere) awaitingCheckout = null
        if (ret.finished) {
            PendingCheckoutReturn.markFinished(ret.invoiceId)
            val running = checkingPayment
            when {
                // Stripe's own address confirms the check focus started.
                running == ret.invoiceId -> checkStartedByFocus = false
                // Another bill is being checked and this window never sent
                // this one to Stripe. The running check keeps its place.
                running != null && !handedOffHere -> scope.launch { read(quietFailure = true) }
                else -> startPaymentCheck(ret.invoiceId, byFocus = false)
            }
            return
        }
        val believed = PendingCheckoutReturn.markCancelled(ret.invoiceId)
        if (believed && checkingPayment == ret.invoiceId && checkStartedByFocus) stopPaymentCheck()
        scope.launch { read(quietFailure = true) }
    }

    /** #2366: "Check again" after a check ran out, or "Tap to sync" during one. */
    fun checkPaymentAgain(invoiceId: String) = startPaymentCheck(invoiceId, byFocus = false)

    private fun stopPaymentCheck() {
        checkJob?.cancel()
        checkJob = null
        checkToken = null
        checkingPayment = null
        checkStartedByFocus = false
    }

    private fun startPaymentCheck(invoiceId: String, byFocus: Boolean) {
        checkJob?.cancel()
        val token = Any()
        checkToken = token
        checkStartedByFocus = byFocus
        paymentNotSeen = null
        // Only this invoice's own hold is lifted here. Another bill's check
        // that read nothing stays held until a read gets through
        // ([settleUncheckedPayment]), whatever this check was started for.
        if (paymentNotChecked == invoiceId) paymentNotChecked = null
        checkingPayment = invoiceId
        checkJob = scope.launch {
            try {
                var waited = 0L
                // #2402: whether any read since the return got through. A read
                // that failed keeps the list already in hand and is tried again
                // on the next tick; it is not an answer about the payment.
                var readSinceReturn = false
                while (true) {
                    if (read(quietFailure = true)) readSinceReturn = true
                    val invoice = find(invoiceId)
                    if (invoice != null && !offersPayment(invoice)) {
                        if (invoice.isPaid || invoice.status == InvoiceStatus.Paid) statusBanner = PAYMENT_RECEIVED
                        return@launch
                    }
                    if (waited >= PAYMENT_CHECK_FOR_MS) break
                    delay(PAYMENT_CHECK_EVERY_MS)
                    waited += PAYMENT_CHECK_EVERY_MS
                }
                // "Has not shown up" claims a read. With none, say that instead
                // and keep Pay held back.
                if (readSinceReturn) paymentNotSeen = invoiceId else paymentNotChecked = invoiceId
            } finally {
                // A newer check owns the state now; this one leaves it alone.
                if (checkToken === token) checkingPayment = null
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
        // Same gate as [startPay], and it matters more here: a Link method is
        // a Venmo/PayPal/Cash App URL that never reaches the server.
        if (!offersPayment(invoice)) {
            if (invoice.isPaid || invoice.status == InvoiceStatus.Paid) error = PAID_INVOICE_REFUSAL
            // #2410: the server's own sentence for a bill that cannot take a payment.
            payBlockedReason(invoice)?.let { error = it }
            return
        }
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
     * refusals here are sentences about THIS quote ("already declined", "not open
     * for an answer right now") and belong beside the buttons that caused them.
     */
    fun startQuoteDecision(invoice: Invoice, accept: Boolean) {
        if (decidingQuote != null) return
        decidingQuote = invoice.id
        quoteError = null
        quoteErrorInvoiceId = null
        statusBanner = null
        scope.launch {
            try {
                // #1281: the confirmation is set AFTER the reload, so it never
                // sits over a list that still shows the quote unanswered.
                val banner = if (accept) {
                    portalApi.acceptQuote(invoiceId = invoice.id, kinfolkId = kinfolkId)
                    "Quote accepted. It is an invoice now."
                } else {
                    portalApi.denyQuote(invoiceId = invoice.id, kinfolkId = kinfolkId)
                    "Quote declined. Your Auntie has been told."
                }
                reload()
                statusBanner = banner
            } catch (c: CancellationException) {
                throw c
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
                // #1281: "Working…" stays up through the reload (`redeeming`
                // clears in `finally`), and the confirmation lands only once the
                // list shows the new balance. Set before the reload, it sat over
                // the old balance and read like a save that had not worked.
                val banner = when (target) {
                    CreditTarget.AccountBalance -> "Credit saved. ${formatCents(res.redeemedAmountCents)} is in your account balance."
                    // #1338: no UI offers this target and the server refuses it
                    // (no-refunds ruling), so this arm is unreachable. It must
                    // never promise a card refund; kept only for exhaustiveness.
                    CreditTarget.OriginalPaymentMethod -> "Credit of ${formatCents(res.redeemedAmountCents)} redeemed."
                }
                reload()
                statusBanner = banner
            } catch (c: CancellationException) {
                throw c
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
    val controller = remember(kinfolkId, portalApi) { InvoicesController(kinfolkId, portalApi, scope) }
    // #2366: Stripe's checkout opens in the browser, which takes the window's
    // focus. Focus coming back is the household returning to this app.
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(controller, focused) {
        if (focused) controller.onAppReturned()
    }
    return controller
}
/** #2366: said once the fresh read shows the bill paid, never before. */
internal const val PAYMENT_RECEIVED = "Payment received."
/** #2402: said when a payment check ran out and no read got through. Same words as the web portal. */
internal const val PAYMENT_NOT_CHECKED = "We could not check this payment. Check again in a minute."


private fun formatCents(cents: Long): String = formatUsd(cents.toDouble() / 100.0)
