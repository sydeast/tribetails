package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.contracts.ArchiveInvoiceArgs
import com.tribetails.auntieos.data.contracts.CreateInvoiceArgs
import com.tribetails.auntieos.data.contracts.CreateQuoteArgs
import com.tribetails.auntieos.data.contracts.GenerateInvoicePdfArgs
import com.tribetails.auntieos.data.contracts.GenerateReceiptArgs
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerArgs
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.contracts.LinkInvoiceSessionsArgs
import com.tribetails.auntieos.data.contracts.LinkInvoiceSessionsResult
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidArgs
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
import com.tribetails.auntieos.data.contracts.PostInvoiceEventArgs
import com.tribetails.auntieos.data.contracts.RecordPaymentArgs
import com.tribetails.auntieos.data.contracts.SendInvoiceReminderArgs
import com.tribetails.auntieos.data.contracts.UnarchiveInvoiceArgs
import com.tribetails.auntieos.data.contracts.decodeCreateInvoiceResult
import com.tribetails.auntieos.data.contracts.decodeCreateQuoteResult
import com.tribetails.auntieos.data.contracts.decodeGenerateInvoicePdfResult
import com.tribetails.auntieos.data.contracts.decodeGetInvoiceLedgerResult
import com.tribetails.auntieos.data.contracts.decodeLinkInvoiceSessionsResult
import com.tribetails.auntieos.data.contracts.decodeMarkInvoicePaidResult
import com.tribetails.auntieos.data.contracts.decodeRecordPaymentResult
import com.tribetails.auntieos.data.contracts.decodeSendInvoiceReminderResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.domain.scopedKinfolkId
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * The INVOICE domain repo (W4-1): invoices, quotes, and the payment ledger that
 * settles them. First of the per-domain repos carved out of the `AuntieRepository`
 * god-file, so an invoice bug is read and fixed in one file instead of a ~3.6k-line
 * one spanning ~25 domains.
 *
 * Invoice-first is not arbitrary: wave 2 (ADR-0002) just finished making this
 * surface coherent. Every write here is a CALLABLE (`/invoices` is callable-only
 * in the Firestore rules, for production and the TestMode sandbox alike) and the
 * client-side invoice classifier is gone, so what moved is a settled surface
 * rather than one still being argued about.
 *
 * Two reads are deliberately NOT routed through [ScopedFirestore]: [getInvoicesForKinfolk]
 * already pins `kinfolkId` itself, and [getInvoiceById] is a doc fetch. Adding the
 * sandbox `whereEqualTo("kinfolkId", testTribeId)` on top of the former would put
 * two equality filters on one field; both are carried over exactly as the god-file
 * had them.
 *
 * EVERY WIRE SHAPE HERE IS GENERATED (ADR-0001). The request classes and the
 * `decode*` functions come from `data.contracts.InvoiceContracts.generated.kt`,
 * which is projected from the server zod schemas; the hand-mirrors this file
 * used to carry are gone. What remains below the class is the thin adaptation
 * from Android's own models to those generated Args, plus the handful of
 * CLIENT-SIDE fallbacks that are not in any schema and are each named at their
 * definition. A schema rename is now a compile error here rather than a silent
 * key mismatch on the wire.
 *
 * @param authGate W4-2: the shared sign-in gate and `testTribeId` claim source.
 *   W4-1 copied the god-file's four-line sign-in check into this file and took
 *   its TestMode as a lambda wired to `AuntieRepository.requireTestMode`; both
 *   compromises are gone. The copy is deleted, the reach-back is deleted, and
 *   the default [AuthGate.shared] keeps the claim read and its cache in exactly
 *   one place across every repo.
 */
class InvoiceRepository(
    internal val authGate: AuthGate = AuthGate.shared,
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
    firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
) {
    // Lazy so merely constructing the repo (e.g. as a ViewModel default in a
    // Firebase-less Robolectric test) never eagerly touches Firebase singletons.
    // Same reason as KinTaleCommentsRepository's providers, and the reason
    // [AuthGate.shared] is safe as a default argument: it is lazy too.
    private val functions: FirebaseFunctions by lazy(functionsProvider)
    private val firestore: FirebaseFirestore by lazy(firestoreProvider)

    /**
     * The Stage-0I seam, built exactly as [AuntieRepository] builds its own: over
     * this repo's firestore handle, sourcing its mode from [authGate] so a new
     * kinfolk-scoped read here cannot forget the sandbox constraint. The gate
     * answers who is signed in; this seam constrains what they can read.
     */
    private val scoped: ScopedFirestore by lazy { ScopedFirestore(firestore, authGate::requireTestMode) }

    // --- Invoices ---

    suspend fun getInvoices(): Result<List<Invoice>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("invoices").toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices", it) }

    suspend fun getInvoicesForKinfolk(kinfolkId: String): Result<List<Invoice>> = runCatching {
        authGate.ensureAuthenticated()
        val snapshot = firestore.collection("invoices")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices for $kinfolkId", it) }

    suspend fun getInvoiceById(invoiceId: String): Result<Invoice> = runCatching {
        authGate.ensureAuthenticated()
        val doc = firestore.collection("invoices").document(invoiceId).get().await()
        doc.toObject(Invoice::class.java)
            ?: throw NoSuchElementException("Invoice $invoiceId not found")
    }.onFailure { AuntieLog.e("Failed to get invoice $invoiceId", it) }

    /**
     * Slice 2: routes through the createInvoice callable (server mints the id,
     * writes audit BILLING_INVOICE_CREATED, and enqueues the invoice.new
     * notification). Replaces the old silent direct Firestore write.
     *
     * Fail-loud on a response that carries no id: the caller's whole reason for
     * calling is to learn the new invoice's id, so returning "" as a success
     * would hand the ViewModel a doc reference that resolves to nothing.
     */
    suspend fun createInvoice(invoice: Invoice): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val mode = authGate.requireTestMode()
        // In test mode force the invoice's household to the sandbox kinfolk so the
        // server write lands inside the rules-enforced scope.
        val args = createInvoiceArgs(invoice, familyId = mode.scopedKinfolkId(invoice.kinfolkId))
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createInvoice").call(args.toPayload()).await().data as? Map<String, Any?>
            ?: error("createInvoice: non-map payload")
        decodeCreateInvoiceResult(raw).invoiceId.ifBlank { error("createInvoice: missing invoiceId") }
    }.onFailure { AuntieLog.e("Failed to create invoice", it) }

    /**
     * Step 4 (PART B): create a QUOTE via the createQuote callable. A quote is NOT a
     * separate model; it is an invoice in QUOTE status. createQuote mirrors
     * createInvoice's args exactly but forces QUOTE status server-side and, when
     * [sendToKinfolk] is true, dispatches the issued-quote notification (catalog key
     * invoice.new) targeting the new invoice doc. Returns the new invoiceId.
     */
    suspend fun createQuote(invoice: Invoice, sendToKinfolk: Boolean): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        val mode = authGate.requireTestMode()
        val args = createQuoteArgs(invoice, familyId = mode.scopedKinfolkId(invoice.kinfolkId), sendToKinfolk = sendToKinfolk)
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createQuote").call(args.toPayload()).await().data as? Map<String, Any?>
            ?: error("createQuote: non-map payload")
        decodeCreateQuoteResult(raw).invoiceId.ifBlank { error("createQuote: missing invoiceId") }
    }.onFailure { AuntieLog.e("Failed to create quote", it) }

    /**
     * Stage 3 / 16.2: generates a downloadable PDF of an invoice via the
     * generateInvoicePdf callable (server renders with pdf-lib + stores to Cloud
     * Storage) and returns the download URL to open. Fail-loud on error: there is
     * nothing to open without a URL, so a blank one is reported rather than
     * launched.
     */
    suspend fun generateInvoicePdf(invoiceId: String): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("generateInvoicePdf")
            .call(GenerateInvoicePdfArgs(invoiceId = invoiceId).toPayload())
            .await().data as? Map<String, Any?>
        decodeGenerateInvoicePdfResult(raw).pdfUrl
            .ifBlank { error("generateInvoicePdf: server returned no pdfUrl") }
    }.onFailure { AuntieLog.e("generateInvoicePdf failed for $invoiceId", it) }

    /**
     * Task 5.1: archives ONE invoice via the archiveInvoice callable, taking it
     * out of the operator's working list and out of the revenue and outstanding
     * tiles. Nothing is deleted and nothing is cancelled; the household still
     * sees the invoice and can still pay it.
     *
     * A CALLABLE RATHER THAN A DIRECT FIRESTORE WRITE (as every invoice write
     * now is - ADR-0002). The server enforces the precondition that actually
     * matters: archiving an invoice money is still owed on removes it from the
     * very total that would remind anyone to collect it, so it is REFUSED unless
     * [force] is set, and a forced archive is audited distinctly as a write-off.
     * A client-side version of that rule is not a rule.
     *
     * Fail-loud: the server's message (still owing, already archived) is
     * surfaced verbatim, because it is the part that tells the operator what to
     * do next.
     */
    suspend fun archiveInvoice(invoiceId: String, force: Boolean = false): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "archiveInvoice requires an invoice id" }
        functions.getHttpsCallable("archiveInvoice").call(archiveInvoiceArgs(invoiceId, force).toPayload()).await()
        Unit
    }.onFailure { AuntieLog.e("archiveInvoice failed for $invoiceId", it) }

    /**
     * Task 5.1: restores an archived invoice to the working list.
     *
     * The server writes `archivedAt: null` rather than deleting the field, so a
     * restored invoice carries the same shape a future backfill would give every
     * legacy invoice. `invoiceIsArchived` reads null as "not archived" for that
     * reason.
     */
    suspend fun unarchiveInvoice(invoiceId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "unarchiveInvoice requires an invoice id" }
        functions.getHttpsCallable("unarchiveInvoice")
            .call(UnarchiveInvoiceArgs(invoiceId = invoiceId).toPayload())
            .await()
        Unit
    }.onFailure { AuntieLog.e("unarchiveInvoice failed for $invoiceId", it) }

    /**
     * Records a payment against an invoice via the `markInvoicePaid` callable,
     * and returns WHERE THE INVOICE STANDS AFTERWARDS.
     *
     * THE SERVER DECIDES, from the sum of every payment recorded against the
     * invoice, not from the amount sent here. A payment that does not cover the
     * total leaves the invoice OPEN with a real remaining balance and comes back
     * `partial`; only a settling payment marks it paid. Until 2026-07-25 that
     * callable wrote `paid` with a zero balance for ANY amount, which is how $20
     * against a $40 invoice made the remaining $20 uncollectable.
     *
     * AN UNREADABLE `state` IS NOW REPORTED, NOT GUESSED. The deleted
     * hand-decoder answered "partial" when it could not read the server's
     * `state`, and the generated decoder answers `""`. Both readings agree that
     * "paid in full" must never be invented; they disagree about whether the
     * client may invent "partial" instead, and the schema settles it: the
     * server's `state` is a required four-member enum built from `settleInvoice`
     * on every path, so there is no absent case for a schema default to
     * describe and no honest wire meaning for "partial" here. The reading that
     * matters to the operator moved up to the presenter, where it is a sentence
     * about what is known rather than a claim about money:
     * `recordPaymentToast` answers a blank state with neither settlement nor a
     * fabricated balance. See RecordPaymentOutcomeTest.
     *
     * Fail-loud: the server's precondition messages (already settled, draft or
     * quote, cancelled, credit) surface verbatim.
     */
    suspend fun markInvoicePaid(
        invoiceId: String,
        amount: Double?,
        method: String,
        reference: String,
    ): Result<MarkInvoicePaidResult> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("markInvoicePaid")
            .call(markInvoicePaidArgs(invoiceId, amount, method, reference).toPayload())
            .await().data as? Map<String, Any?>
        decodeMarkInvoicePaidResult(raw)
    }.onFailure { AuntieLog.e("markInvoicePaid failed for $invoiceId", it) }

    /** Slice 2: marks an invoice receipted via the generateReceipt callable. */
    suspend fun generateReceipt(invoiceId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        functions.getHttpsCallable("generateReceipt")
            .call(GenerateReceiptArgs(invoiceId = invoiceId).toPayload())
            .await()
        Unit
    }.onFailure { AuntieLog.e("generateReceipt failed for $invoiceId", it) }

    /**
     * Stage 2 tail: admin-initiated on-demand resend of a single invoice reminder
     * via the sendInvoiceReminder callable (reuses the cron's per-invoice dispatch
     * path; stamps reminderNotifiedAtMs for idempotency). Returns the invoiceId on
     * success. Fail-loud: the server message (already-paid, not-found, etc.) is
     * surfaced verbatim.
     */
    suspend fun sendInvoiceReminder(invoiceId: String): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendInvoiceReminder")
            .call(SendInvoiceReminderArgs(invoiceId = invoiceId).toPayload())
            .await().data as? Map<String, Any?>
        reminderInvoiceIdOrRequested(raw, invoiceId)
    }.onFailure { AuntieLog.e("sendInvoiceReminder failed for $invoiceId", it) }

    /**
     * Stage 2 tail: transition a DRAFT invoice to "sent" via the postInvoiceEvent
     * callable. postInvoiceEvent merges the supplied payload onto invoices/{invoiceId}
     * and (because the doc already exists) fires the invoice.updated notification.
     * Only the status field is merged, leaving the rest of the invoice untouched.
     *
     * NAMED FOR WHAT IT DOES, NOT FOR THE CALLABLE IT USES: the server also has a
     * dedicated `reviewAndSendDraftInvoice` callable, and this method does not
     * call it. Re-pointing is a behaviour change (a different guard, a different
     * audit event) and belongs to whoever makes it deliberately, so ADR-0001
     * adoption leaves the target alone and only replaces the payload map.
     */
    suspend fun reviewAndSendDraftInvoice(invoiceId: String, familyId: String): Result<Unit> = runCatching {
        authGate.ensureAuthenticated()
        val mode = authGate.requireTestMode()
        val args = PostInvoiceEventArgs(
            familyId = mode.scopedKinfolkId(familyId),
            invoiceId = invoiceId,
            payload = mapOf("status" to "sent"),
        )
        functions.getHttpsCallable("postInvoiceEvent").call(args.toPayload()).await()
        Unit
    }.onFailure { AuntieLog.e("reviewAndSendDraftInvoice failed for $invoiceId", it) }

    /**
     * W2-2 of ADR-0002: sets the invoice's session set via the
     * linkInvoiceSessions callable, which owns BOTH directions atomically.
     * This replaced two direct Firestore writers, `updateInvoiceSessionIds`
     * (invoice side) and a per-session `updateSessionInvoiceId` loop in the
     * ViewModel, whose log-and-continue could strand the invoice claiming a
     * session that still pointed elsewhere when a mid-loop write failed.
     *
     * [sessionIds] is the invoice's FULL new set, not a delta; `[]` unlinks
     * everything. The server derives added/removed against the stored set
     * INSIDE its transaction, so two concurrent saves cannot both compute
     * against the same stale snapshot. The attribution stamps the direct
     * writes made (`manual` / `manual_unlink`, a removed session's invoiceId
     * cleared to '' rather than deleted) are preserved byte-for-byte
     * server-side, and TestMode scoping is server-side too.
     *
     * Fail-loud: the server's messages (invoice not found, session_not_found
     * with the missing ids, sandbox permission-denied) surface verbatim, and
     * on any failure NOTHING was written anywhere - the transaction is atomic.
     */
    suspend fun linkInvoiceSessions(invoiceId: String, sessionIds: List<String>): Result<LinkInvoiceSessionsResult> = runCatching {
        authGate.ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "linkInvoiceSessions requires an invoice id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("linkInvoiceSessions")
            .call(LinkInvoiceSessionsArgs(invoiceId = invoiceId, sessionIds = sessionIds).toPayload())
            .await().data as? Map<String, Any?>
        invoiceSessionLinksOf(raw, invoiceId, sessionIds).also {
            AuntieLog.i("Linked ${it.sessionIds.size} session(s) to invoice $invoiceId (+${it.added.size}/-${it.removed.size})")
        }
    }.onFailure { AuntieLog.e("linkInvoiceSessions failed for $invoiceId", it) }

    // --- Payments ---

    /**
     * THE INVOICE'S MONEY, READ IN THE UNITS IT WAS ACTUALLY STORED IN.
     *
     * `stripeWebhook.ts` writes the ROOT `payments` row's `amount` in CENTS when
     * the figure came off the Stripe event and in DOLLARS when it fell back to
     * the local invoice, distinguishable only by a sibling `amountSource` field.
     * A $137.50 card payment is stored as `amount: 13750`. [getPayments] below
     * reads that field raw, and the [Payment] model has no `amountCents` or
     * `amountSource` to tell the two apart even in principle — which is why the
     * invoice screen printed $13,750.00 for months after the web ledger was
     * fixed.
     *
     * The rule that resolves it is `resolveLedgerAmountCents`, server-side, and
     * it stays there. A Kotlin copy of a money rule that already exists in
     * TypeScript is how the two drift, and this repo has been bitten by that
     * twice. So the invoice screen asks the SAME callable the web ledger asks,
     * and everything comes back in integer cents already resolved.
     *
     * THREE LISTS, NOT INTERCHANGEABLE (the callable's own header is the
     * authority): `payments` is the `invoices/{id}/payments` subcollection and
     * the settlement authority; `ledgerPayments` is the root-collection display
     * ledger naming this invoice; `unlinkedKinfolkPayments` is same-household
     * money no bill claims, which this screen shows under an explicit
     * "NOT INVOICE-LINKED" warning and never counts toward anything.
     *
     * Fail-loud: a failure surfaces; it does not fall back to the raw read.
     * Falling back would silently restore the 100x defect on exactly the days
     * the callable is unhealthy.
     */
    suspend fun getInvoiceLedger(invoiceId: String): Result<GetInvoiceLedgerResult> = runCatching {
        authGate.ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "getInvoiceLedger requires an invoice id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getInvoiceLedger")
            .call(GetInvoiceLedgerArgs(invoiceId = invoiceId).toPayload())
            .await().data as? Map<String, Any?>
        decodeGetInvoiceLedgerResult(raw)
    }.onFailure { AuntieLog.e("getInvoiceLedger failed for $invoiceId", it) }

    /**
     * The RAW root `payments` read. Still here, still called by
     * `AdminDataViewModel.loadPayments`.
     *
     * IT RETURNS AMBIGUOUS UNITS and always has: see [getInvoiceLedger] above.
     * `Payment.amount` is a dollar Double on a `local-invoice` or legacy row and
     * an already-cents integer on a `stripe-event` one, and this model carries
     * neither `amountCents` nor `amountSource` to tell them apart. Anything that
     * renders money out of this list is wrong by 100x on Stripe-paid rows.
     *
     * NOT DELETED, deliberately: payment code in this repo is reported, never
     * cleaned up on a call-graph argument. Its one caller populates a
     * `StateFlow` no composable currently collects, so nothing renders the bad
     * figure today — but "nothing renders it today" is a fact about the UI, not
     * a property of this function, and the next screen to collect that flow
     * inherits the defect. Route new work through [getInvoiceLedger].
     */
    suspend fun getPayments(): Result<List<Payment>> = runCatching {
        authGate.ensureAuthenticated()
        scoped.scopedQuery("payments").toObjects(Payment::class.java)
    }.onFailure { AuntieLog.e("Failed to get payments", it) }

    /**
     * W2-2 of ADR-0002: records a row in the ROOT `payments` collection (the
     * DISPLAY ledger the payment screens read) via the recordPayment callable,
     * replacing Android's last direct Firestore write on money data. The old
     * client-side TestMode copy (`mode.scopedKinfolkId`) is GONE on purpose:
     * the server stamps a sandbox caller's row `kinfolkId = testTribeId` no
     * matter what the request says (mytribe/functions/src/lib/testMode.ts),
     * which a modified client cannot skip the way it could skip a client-side
     * rewrite. This is NOT markInvoicePaid - that callable is the money
     * authority (invoice subcollection + settlement); this one writes the
     * display row only and can record a standalone payment with no invoice at
     * all. Returns the new payment doc id.
     */
    suspend fun createPayment(payment: Payment): Result<String> = runCatching {
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("recordPayment")
            .call(recordPaymentArgs(payment).toPayload())
            .await().data as? Map<String, Any?>
            ?: error("recordPayment: non-map payload")
        decodeRecordPaymentResult(raw).paymentId.ifBlank { error("recordPayment: missing paymentId") }
    }.onFailure { AuntieLog.e("Failed to record payment", it) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model -> generated Args, and the client-side fallbacks
//
// What used to live here was a set of hand-mirrors: payload maps and `decode*`
// functions that transcribed the server zod schemas key by key, with nothing
// but review discipline holding them to it. ADR-0001 deleted them. What is left
// is the part no schema can state: how Android's own [Invoice] and [Payment]
// models map onto the generated request classes, and the three fallbacks this
// client applies on top of a generated decode. Every one of them is pure and
// unit-tested (InvoiceRepositoryTest), so they run without Firebase static init.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * [Invoice] -> `createInvoice` request.
 *
 * [familyId] is passed in already TestMode-scoped rather than read here, so this
 * stays pure and the sandbox decision has exactly one home (the caller).
 * `lineItems` and `invoiceDiscountCents` are left at their generated defaults:
 * Android's composer sends the dollar `total`/`amountDue` pair, and the server
 * treats the line-item pair as the alternative to it, not an addition.
 */
internal fun createInvoiceArgs(invoice: Invoice, familyId: String): CreateInvoiceArgs = CreateInvoiceArgs(
    familyId = familyId,
    kinfolkName = invoice.kinfolkName,
    invoiceNumber = invoice.invoiceNumber,
    client = invoice.client,
    address = invoice.address,
    date = invoice.date,
    terms = invoice.terms,
    dueDate = invoice.dueDate,
    discount = invoice.discount,
    total = invoice.total,
    amountDue = invoice.amountDue,
    status = invoice.status,
    sessionIds = invoice.sessionIds,
)

/**
 * [Invoice] -> `createQuote` request.
 *
 * `status` IS LEFT AT THE SCHEMA DEFAULT, deliberately, where
 * [createInvoiceArgs] forwards the model's. createQuote mints in QUOTE status
 * "regardless of what the caller passes" (admin/createQuote.ts) and never reads
 * the arg, so forwarding a composer's draft status here would put a value on the
 * wire that reads as a request the server refuses to honour.
 */
internal fun createQuoteArgs(invoice: Invoice, familyId: String, sendToKinfolk: Boolean): CreateQuoteArgs = CreateQuoteArgs(
    familyId = familyId,
    kinfolkName = invoice.kinfolkName,
    invoiceNumber = invoice.invoiceNumber,
    client = invoice.client,
    address = invoice.address,
    date = invoice.date,
    terms = invoice.terms,
    dueDate = invoice.dueDate,
    discount = invoice.discount,
    total = invoice.total,
    amountDue = invoice.amountDue,
    sessionIds = invoice.sessionIds,
    sendToKinfolk = sendToKinfolk,
)

/**
 * The `markInvoicePaid` request.
 *
 * A BLANK method or reference IS OMITTED, NOT SENT BLANK. The dialog leaves
 * both empty when the operator does not fill them in, and the server types them
 * `z.string().trim().min(1).optional()`: an empty string is not a weaker
 * version of an absent one there, it is a validation failure that refuses the
 * whole payment. Only [amount] may legitimately be null, and the generated
 * class omits a null for us.
 */
internal fun markInvoicePaidArgs(
    invoiceId: String,
    amount: Double?,
    method: String,
    reference: String,
): MarkInvoicePaidArgs = MarkInvoicePaidArgs(
    invoiceId = invoiceId,
    amount = amount,
    method = method.takeIf { it.isNotBlank() },
    reference = reference.takeIf { it.isNotBlank() },
)

/**
 * The `archiveInvoice` request. An unforced archive omits `force` rather than
 * sending `false`, which is the shape this callable has always been called
 * with: the flag exists to say a write-off was chosen, and every audited
 * archive should be able to tell "not forced" from "the client had an opinion".
 */
internal fun archiveInvoiceArgs(invoiceId: String, force: Boolean): ArchiveInvoiceArgs =
    ArchiveInvoiceArgs(invoiceId = invoiceId, force = force.takeIf { it })

/**
 * [Payment] -> `recordPayment` request: every field of Android's model EXCEPT
 * `id` (@DocumentId, never serialized; the server mints the doc id and returns
 * it). Amount and tip stay DOLLARS-as-floats, the legacy shape of this
 * collection. No TestMode anywhere: the sandbox kinfolkId stamp is the server's
 * job now.
 */
internal fun recordPaymentArgs(payment: Payment): RecordPaymentArgs = RecordPaymentArgs(
    kinfolkId = payment.kinfolkId,
    kinfolkName = payment.kinfolkName,
    client = payment.client,
    address = payment.address,
    date = payment.date,
    paymentMethod = payment.paymentMethod,
    referenceNumber = payment.referenceNumber,
    email = payment.email,
    amount = payment.amount,
    tip = payment.tip,
    fee = payment.fee,
    notes = payment.notes,
    invoiceId = payment.invoiceId,
    invoiceNumber = payment.invoiceNumber,
    autoApply = payment.autoApply,
    sendConfirmationEmail = payment.sendConfirmationEmail,
    // NO `apply`, DELIBERATELY. `InvoiceDetailViewModel.recordPayment` calls
    // `markInvoicePaid` FIRST, which has already settled the invoice by the time
    // this row is written; sending an apply here would put the same money
    // against the same bill a second time. `invoiceId` above stays what it has
    // always been: the display link the Payments screens join on.
)

/**
 * The invoiceId `sendInvoiceReminder` echoed, falling back to the one we asked
 * about.
 *
 * A CLIENT FALLBACK, NOT A SCHEMA DEFAULT, and it is safe for the same reason
 * the settlement state's is not: this value is not news. We are decoding an
 * echo of the id we just sent, on a call that already succeeded, so the fallback
 * restates something the caller knows rather than inventing something only the
 * server could know.
 */
internal fun reminderInvoiceIdOrRequested(raw: Map<String, Any?>?, requested: String): String =
    decodeSendInvoiceReminderResult(raw).invoiceId.ifBlank { requested }

/**
 * The `linkInvoiceSessions` response, with the two echoed fields falling back to
 * what was requested.
 *
 * `sessionIds` FALLS BACK ONLY WHEN THE KEY IS ABSENT, never when it is present
 * and empty: `[]` is the server saying everything was unlinked, and the
 * generated decoder cannot tell that apart from a missing key because both are
 * an empty list to it. The distinction is real - an unlink is the one save
 * whose stored set is empty - so it is made here, off the raw payload, before
 * the decode collapses it. `added`, `removed`, `status` and `editScope` are the
 * generated decoder's unaltered: they are the server's derivation and this
 * client has nothing to fall back to.
 */
internal fun invoiceSessionLinksOf(
    raw: Map<String, Any?>?,
    requestedInvoiceId: String,
    requestedSessionIds: List<String>,
): LinkInvoiceSessionsResult {
    val decoded = decodeLinkInvoiceSessionsResult(raw)
    return decoded.copy(
        invoiceId = decoded.invoiceId.ifBlank { requestedInvoiceId },
        sessionIds = if (raw?.get("sessionIds") is List<*>) decoded.sessionIds else requestedSessionIds.distinct(),
    )
}
