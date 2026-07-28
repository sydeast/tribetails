package com.tribetails.auntieos.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.domain.TestMode
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
 * The payload encoders/decoders below are HAND-MIRRORS of the server zod schemas
 * and live with the repo that sends them. ADR-0001 replaces them with generated
 * Kotlin; they keep the `recordPaymentPayload` / `decodeInvoiceSettlement`
 * convention so that swap is mechanical.
 *
 * @param requireTestMode the fail-loud TestMode source, the same lambda shape
 *   [ScopedFirestore] takes. It is passed in rather than read here because the
 *   `testTribeId` claim (and its cache) belongs to the Auth domain, which is a
 *   later carve; today `AuntieOSApp` wires it to `AuntieRepository.requireTestMode`
 *   so there is still exactly ONE claim reader in the app.
 */
class InvoiceRepository(
    private val requireTestMode: suspend () -> TestMode,
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
    firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
    authProvider: () -> FirebaseAuth = { FirebaseAuth.getInstance() },
) {
    // Lazy so merely constructing the repo (e.g. as a ViewModel default in a
    // Firebase-less Robolectric test) never eagerly touches Firebase singletons.
    // Same reason as KinTaleCommentsRepository's providers.
    private val functions: FirebaseFunctions by lazy(functionsProvider)
    private val firestore: FirebaseFirestore by lazy(firestoreProvider)
    private val auth: FirebaseAuth by lazy(authProvider)

    /**
     * The Stage-0I seam, built exactly as [AuntieRepository] builds its own: over
     * this repo's firestore handle, holding [requireTestMode] itself so a new
     * kinfolk-scoped read here cannot forget the sandbox constraint.
     */
    private val scoped: ScopedFirestore by lazy { ScopedFirestore(firestore, requireTestMode) }

    /**
     * Verbatim copy of the god-file's sign-in gate, so a signed-out call still
     * fails with this sentence rather than a raw Firebase error. It is a copy on
     * purpose and with a named owner: the gate consolidates when the Auth domain
     * repo is carved (see CONTEXT.md "Domain repos").
     */
    private fun ensureAuthenticated() {
        if (auth.currentUser == null) {
            throw IllegalStateException("Admin sign-in required before using AuntieOS.")
        }
    }

    // --- Invoices ---

    suspend fun getInvoices(): Result<List<Invoice>> = runCatching {
        ensureAuthenticated()
        scoped.scopedQuery("invoices").toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices", it) }

    suspend fun getInvoicesForKinfolk(kinfolkId: String): Result<List<Invoice>> = runCatching {
        ensureAuthenticated()
        val snapshot = firestore.collection("invoices")
            .whereEqualTo("kinfolkId", kinfolkId)
            .get()
            .await()
        snapshot.toObjects(Invoice::class.java)
    }.onFailure { AuntieLog.e("Failed to get invoices for $kinfolkId", it) }

    suspend fun getInvoiceById(invoiceId: String): Result<Invoice> = runCatching {
        ensureAuthenticated()
        val doc = firestore.collection("invoices").document(invoiceId).get().await()
        doc.toObject(Invoice::class.java)
            ?: throw NoSuchElementException("Invoice $invoiceId not found")
    }.onFailure { AuntieLog.e("Failed to get invoice $invoiceId", it) }

    /**
     * Slice 2: routes through the createInvoice callable (server mints the id,
     * writes audit BILLING_INVOICE_CREATED, and enqueues the invoice.new
     * notification). Replaces the old silent direct Firestore write.
     */
    suspend fun createInvoice(invoice: Invoice): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        // In test mode force the invoice's household to the sandbox kinfolk so the
        // server write lands inside the rules-enforced scope.
        val scopedFamilyId = mode.scopedKinfolkId(invoice.kinfolkId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "kinfolkName" to invoice.kinfolkName,
            "invoiceNumber" to invoice.invoiceNumber,
            "client" to invoice.client,
            "address" to invoice.address,
            "date" to invoice.date,
            "terms" to invoice.terms,
            "dueDate" to invoice.dueDate,
            "discount" to invoice.discount,
            "total" to invoice.total,
            "amountDue" to invoice.amountDue,
            "status" to invoice.status,
            "sessionIds" to invoice.sessionIds,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createInvoice").call(payload).await().data as? Map<String, Any?>
            ?: error("createInvoice: non-map payload")
        raw["invoiceId"] as? String ?: error("createInvoice: missing invoiceId")
    }.onFailure { AuntieLog.e("Failed to create invoice", it) }

    /**
     * Step 4 (PART B): create a QUOTE via the createQuote callable. A quote is NOT a
     * separate model; it is an invoice in QUOTE status. createQuote mirrors
     * createInvoice's args exactly but forces QUOTE status server-side and, when
     * [sendToKinfolk] is true, dispatches the issued-quote notification (catalog key
     * invoice.new) targeting the new invoice doc. Returns the new invoiceId.
     */
    suspend fun createQuote(invoice: Invoice, sendToKinfolk: Boolean): Result<String> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val scopedFamilyId = mode.scopedKinfolkId(invoice.kinfolkId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "kinfolkName" to invoice.kinfolkName,
            "invoiceNumber" to invoice.invoiceNumber,
            "client" to invoice.client,
            "address" to invoice.address,
            "date" to invoice.date,
            "terms" to invoice.terms,
            "dueDate" to invoice.dueDate,
            "discount" to invoice.discount,
            "total" to invoice.total,
            "amountDue" to invoice.amountDue,
            "sessionIds" to invoice.sessionIds,
            "sendToKinfolk" to sendToKinfolk,
        )
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("createQuote").call(payload).await().data as? Map<String, Any?>
            ?: error("createQuote: non-map payload")
        raw["invoiceId"] as? String ?: error("createQuote: missing invoiceId")
    }.onFailure { AuntieLog.e("Failed to create quote", it) }

    /**
     * Stage 3 / 16.2: generates a downloadable PDF of an invoice via the
     * generateInvoicePdf callable (server renders with pdf-lib + stores to Cloud
     * Storage) and returns the download URL to open. Fail-loud on error.
     */
    suspend fun generateInvoicePdf(invoiceId: String): Result<String> = runCatching {
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("generateInvoicePdf")
            .call(mapOf("invoiceId" to invoiceId))
            .await().data as? Map<String, Any?>
        (raw?.get("pdfUrl") as? String)?.takeIf { it.isNotBlank() }
            ?: error("generateInvoicePdf: server returned no pdfUrl")
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
        ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "archiveInvoice requires an invoice id" }
        val payload = if (force) mapOf("invoiceId" to invoiceId, "force" to true) else mapOf("invoiceId" to invoiceId)
        functions.getHttpsCallable("archiveInvoice").call(payload).await()
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
        ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "unarchiveInvoice requires an invoice id" }
        functions.getHttpsCallable("unarchiveInvoice")
            .call(mapOf("invoiceId" to invoiceId))
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
     * Fail-loud: the server's precondition messages (already settled, draft or
     * quote, cancelled, credit) surface verbatim.
     */
    suspend fun markInvoicePaid(
        invoiceId: String,
        amount: Double?,
        method: String,
        reference: String,
    ): Result<InvoiceSettlement> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any> {
            put("invoiceId", invoiceId)
            if (amount != null) put("amount", amount)
            if (method.isNotBlank()) put("method", method)
            if (reference.isNotBlank()) put("reference", reference)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("markInvoicePaid")
            .call(payload)
            .await().data as? Map<String, Any?>
        decodeInvoiceSettlement(raw)
    }.onFailure { AuntieLog.e("markInvoicePaid failed for $invoiceId", it) }

    /** Slice 2: marks an invoice receipted via the generateReceipt callable. */
    suspend fun generateReceipt(invoiceId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        functions.getHttpsCallable("generateReceipt")
            .call(mapOf("invoiceId" to invoiceId))
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
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendInvoiceReminder")
            .call(mapOf("invoiceId" to invoiceId))
            .await().data as? Map<String, Any?>
        decodeSentReminderInvoiceId(raw, invoiceId)
    }.onFailure { AuntieLog.e("sendInvoiceReminder failed for $invoiceId", it) }

    /**
     * Stage 2 tail: transition a DRAFT invoice to "sent" via the postInvoiceEvent
     * callable. postInvoiceEvent merges the supplied payload onto invoices/{invoiceId}
     * and (because the doc already exists) fires the invoice.updated notification.
     * Only the status field is merged, leaving the rest of the invoice untouched.
     */
    suspend fun reviewAndSendDraftInvoice(invoiceId: String, familyId: String): Result<Unit> = runCatching {
        ensureAuthenticated()
        val mode = requireTestMode()
        val scopedFamilyId = mode.scopedKinfolkId(familyId)
        val payload = mapOf(
            "familyId" to scopedFamilyId,
            "invoiceId" to invoiceId,
            "payload" to mapOf("status" to "sent"),
        )
        functions.getHttpsCallable("postInvoiceEvent").call(payload).await()
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
    suspend fun linkInvoiceSessions(invoiceId: String, sessionIds: List<String>): Result<InvoiceSessionLinks> = runCatching {
        ensureAuthenticated()
        require(invoiceId.isNotBlank()) { "linkInvoiceSessions requires an invoice id" }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("linkInvoiceSessions")
            .call(mapOf("invoiceId" to invoiceId, "sessionIds" to sessionIds))
            .await().data as? Map<String, Any?>
        decodeInvoiceSessionLinks(raw, invoiceId, sessionIds).also {
            AuntieLog.i("Linked ${it.sessionIds.size} session(s) to invoice $invoiceId (+${it.added.size}/-${it.removed.size})")
        }
    }.onFailure { AuntieLog.e("linkInvoiceSessions failed for $invoiceId", it) }

    // --- Payments ---

    suspend fun getPayments(): Result<List<Payment>> = runCatching {
        ensureAuthenticated()
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
        ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("recordPayment")
            .call(recordPaymentPayload(payment))
            .await().data as? Map<String, Any?>
            ?: error("recordPayment: non-map payload")
        raw["paymentId"] as? String ?: error("recordPayment: missing paymentId")
    }.onFailure { AuntieLog.e("Failed to record payment", it) }
}

/**
 * Where an invoice stands after a payment, as the `markInvoicePaid` callable
 * reports it. Every figure is INTEGER CENTS.
 *
 * [amountDueCents] is never negative: an overpayment settles the invoice and
 * puts the excess in [overpaidCents] instead, because a negative balance is this
 * codebase's CREDIT signal and would silently turn an over-collected invoice
 * into a credit owed back to the household.
 */
data class InvoiceSettlement(
    /** One of `unpaid`, `partial`, `settled`, `overpaid`. */
    val state: String,
    val totalCents: Long,
    val paidCents: Long,
    val amountDueCents: Long,
    val overpaidCents: Long,
) {
    val isPartial: Boolean get() = state == "partial"
    val isOverpaid: Boolean get() = state == "overpaid"
}

/**
 * Pure decode of the markInvoicePaid callable payload into [InvoiceSettlement].
 *
 * A MISSING `state` DECODES TO "partial", NOT TO "settled". If the server's
 * answer cannot be read, the safe reading is that the invoice may still be
 * owed: that keeps it in Outstanding and keeps the operator able to collect,
 * which is exactly what the original defect took away. Defaulting the other way
 * would reproduce the bug in the client. Pure; unit-tested.
 */
internal fun decodeInvoiceSettlement(raw: Map<String, Any?>?): InvoiceSettlement {
    fun cents(key: String): Long = (raw?.get(key) as? Number)?.toLong() ?: 0L
    val state = (raw?.get("state") as? String)?.takeIf { it.isNotBlank() } ?: "partial"
    return InvoiceSettlement(
        state = state,
        totalCents = cents("totalCents"),
        paidCents = cents("paidCents"),
        amountDueCents = cents("amountDueCents"),
        overpaidCents = cents("overpaidCents"),
    )
}

/**
 * Pure decode of the sendInvoiceReminder callable payload to the echoed invoiceId,
 * falling back to the requested id when the server omits it. Pure; unit-tested.
 */
internal fun decodeSentReminderInvoiceId(raw: Map<String, Any?>?, requested: String): String =
    (raw?.get("invoiceId") as? String)?.ifBlank { requested } ?: requested

/**
 * The invoice<->session link set after a linkInvoiceSessions write, as the
 * server reports it: the stored full set, the delta the transaction actually
 * applied, and the classifier state persisted onto the invoice doc
 * (ADR-0002 decision 2).
 */
data class InvoiceSessionLinks(
    val invoiceId: String,
    /** The stored set after this write. */
    val sessionIds: List<String>,
    /** Sessions that gained `invoiceId` in this write. */
    val added: List<String>,
    /** Sessions whose `invoiceId` was cleared in this write. */
    val removed: List<String>,
    /** Classifier state persisted onto the invoice (e.g. `sent`); "" if omitted. */
    val status: String,
    /** `all` | `metadataOnly` | `none`; "" if omitted. */
    val editScope: String,
)

/**
 * Pure decode of the linkInvoiceSessions callable payload into
 * [InvoiceSessionLinks]. The echoed invoiceId/sessionIds fall back to what was
 * requested (the call succeeded if we got here; the server stores the
 * requested set with duplicates collapsed, hence the distinct()). added and
 * removed default to empty and status/editScope to "" when the server omits
 * them. Pure; unit-tested.
 */
internal fun decodeInvoiceSessionLinks(
    raw: Map<String, Any?>?,
    requestedInvoiceId: String,
    requestedSessionIds: List<String>,
): InvoiceSessionLinks {
    fun ids(key: String): List<String> =
        (raw?.get(key) as? List<*>).orEmpty().mapNotNull { it as? String }
    return InvoiceSessionLinks(
        invoiceId = (raw?.get("invoiceId") as? String)?.ifBlank { requestedInvoiceId } ?: requestedInvoiceId,
        sessionIds = if (raw?.get("sessionIds") is List<*>) ids("sessionIds") else requestedSessionIds.distinct(),
        added = ids("added"),
        removed = ids("removed"),
        status = (raw?.get("status") as? String).orEmpty(),
        editScope = (raw?.get("editScope") as? String).orEmpty(),
    )
}

/**
 * Pure encode of the recordPayment callable payload. Hand-mirrors the server
 * zod Args (mytribe/functions/src/admin/recordPayment.ts) field for field:
 * every field of Android's [Payment] model EXCEPT `id` (@DocumentId, never
 * serialized; the server mints the doc id and returns it). Amount and tip stay
 * DOLLARS-as-floats, the legacy shape of this collection. No TestMode
 * anywhere: the sandbox kinfolkId stamp is the server's job now. Pure;
 * unit-tested.
 */
internal fun recordPaymentPayload(payment: Payment): Map<String, Any?> = mapOf(
    "kinfolkId" to payment.kinfolkId,
    "kinfolkName" to payment.kinfolkName,
    "client" to payment.client,
    "address" to payment.address,
    "date" to payment.date,
    "paymentMethod" to payment.paymentMethod,
    "referenceNumber" to payment.referenceNumber,
    "email" to payment.email,
    "amount" to payment.amount,
    "tip" to payment.tip,
    "notes" to payment.notes,
    "invoiceId" to payment.invoiceId,
    "invoiceNumber" to payment.invoiceNumber,
)
