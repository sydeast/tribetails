package com.tribetails.auntieos.ui.invoices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.formatCentsUsd
import com.tribetails.auntieos.domain.invoicePartPaid
import com.tribetails.auntieos.domain.invoiceStateOrNull
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class InvoiceDetailUiState(
    val invoice: Invoice? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    // Session-link state
    val availableSessions: List<KinCareSession> = emptyList(),
    val sessionsLoading: Boolean = false,
    val editMode: Boolean = false,
    val pendingSessionIds: Set<String> = emptySet(),
    val saveLoading: Boolean = false,
    val toastMessage: String = "",
    val toastVisible: Boolean = false,
    val toastIsError: Boolean = false,
    /**
     * The invoice's DISPLAY ledger (spec 17 items 5/6): root `payments` rows
     * naming this invoice, as `getInvoiceLedger` returns them — every figure
     * already in INTEGER CENTS, resolved server-side.
     *
     * The type change away from `List<Payment>` IS the fix, not incidental to
     * it. `Payment.amount` is a `Double` whose unit depends on an `amountSource`
     * field the Kotlin model does not carry, so a Stripe-sourced row rendered
     * 100x too large. Nothing ambiguous reaches a formatter on this path now.
     */
    val linkedPayments: List<GetInvoiceLedgerResultLedgerPayment> = emptyList(),
    /**
     * Stage 2 Step 2, now served by the callable: same-household money that
     * names NO invoice, shown under a visible "NOT INVOICE-LINKED" warning when
     * there is no confident per-invoice payment yet. Never counted toward
     * anything, never implied to belong to this bill.
     *
     * This list used to be filtered client-side out of a raw read of the WHOLE
     * root `payments` collection, and that read is what kept the 100x defect
     * alive on this screen.
     */
    val clientPayments: List<GetInvoiceLedgerResultLedgerPayment> = emptyList(),
    val showRecordPayment: Boolean = false,
    val recordingPayment: Boolean = false,
    // Stage 2 tail: header receipt / reminder + draft review-and-send actions.
    val generatingReceipt: Boolean = false,
    val sendingReminder: Boolean = false,
    val sendingDraft: Boolean = false,
    // Stage 3 / 16.2: invoice PDF download. pdfUrlToOpen is a one-shot the screen
    // consumes (opens via Intent) then clears via consumePdfUrl().
    val generatingPdf: Boolean = false,
    val pdfUrlToOpen: String? = null,
    // A8 Payments: the operator's payment handles, for the invoice "How to pay" section.
    val businessSettings: com.tribetails.auntieos.data.model.BusinessSettings? = null,
    // Task 5.1 archive/restore. `archiveForceOffered` is set only after the
    // SERVER refuses because money is still owed: that refusal is a decision to
    // put back to the operator as an explicit write-off, not an error to bounce
    // off, so the confirm re-renders rather than closing.
    val archivePrompt: Boolean = false,
    val archiveForceOffered: Boolean = false,
    val archiving: Boolean = false,
)

/**
 * W4-1: this screen is invoice work, so it injects [InvoiceRepository] directly
 * rather than reaching through a facade. [repository] is still here for the
 * collaborators that are NOT invoice domain and have not been carved yet: the
 * kin-care session list, business settings, and the AuditLog writer.
 */
class InvoiceDetailViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    private val invoiceRepository: InvoiceRepository = AuntieOSApp.instance.invoiceRepository,
    // W4-3: the session-link picker lists the household's visits, which is a
    // KinCare read. The LINK itself is still written by the invoice callable.
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(InvoiceDetailUiState())
    val uiState: StateFlow<InvoiceDetailUiState> = _uiState.asStateFlow()

    fun loadInvoice(invoiceId: String) {
        _uiState.value = InvoiceDetailUiState(isLoading = true)
        viewModelScope.launch {
            invoiceRepository.getInvoiceById(invoiceId)
                .onSuccess { invoice ->
                    _uiState.value = _uiState.value.copy(
                        invoice   = invoice,
                        isLoading = false,
                        error     = null,
                    )
                    loadSessionsForKinfolk(invoice.kinfolkId)
                    loadPaymentsForInvoice(invoice.id)
                    loadBusinessSettings()
                }
                .onFailure { err ->
                    _uiState.value = InvoiceDetailUiState(
                        isLoading = false,
                        error = err.message ?: "Failed to load invoice",
                    )
                }
        }
    }

    /** A8 Payments: fetch the operator's payment handles for the "How to pay" section.
     *  Fail-soft: if it can't load, the section simply doesn't render (no fake handles). */
    private fun loadBusinessSettings() {
        viewModelScope.launch {
            repository.getBusinessSettings().onSuccess { bs ->
                _uiState.value = _uiState.value.copy(businessSettings = bs)
            }
        }
    }

    /**
     * BOTH PAYMENT LISTS, FROM THE CALLABLE, IN CENTS.
     *
     * This used to read the ROOT `payments` collection directly and do the
     * per-invoice join and the household fallback here, in Kotlin, on
     * `Payment.amount` — a `Double` whose unit depends on an `amountSource`
     * field the model does not carry. A Stripe-sourced row's `amount` is
     * already integer cents, so the screen rendered $13,750.00 for a $137.50
     * card payment. The rule that reads such a row honestly lives once, in the
     * server's `resolveLedgerAmountCents`; asking the callable is how this
     * screen gets it instead of keeping a second copy that can drift.
     *
     * NO kinfolkId ARGUMENT ANY MORE: the server derives the household from the
     * invoice it just read, so the two can no longer disagree about which
     * household's unattributed payments are being offered.
     *
     * Fail-loud: a failure surfaces in the toast and BOTH lists are left as they
     * were. There is deliberately no fall back to the raw Firestore read — that
     * would restore the 100x defect on exactly the days the callable is
     * unhealthy, which is the worst possible time to start guessing at money.
     */
    private fun loadPaymentsForInvoice(invoiceId: String) {
        if (invoiceId.isBlank()) return
        viewModelScope.launch {
            invoiceRepository.getInvoiceLedger(invoiceId)
                .onSuccess { ledger ->
                    _uiState.value = _uiState.value.copy(
                        linkedPayments = ledger.ledgerPayments,
                        clientPayments = ledger.unlinkedKinfolkPayments,
                    )
                }
                .onFailure { err ->
                    AuntieLog.e("Failed to load payments for invoice $invoiceId", err)
                    _uiState.value = _uiState.value.copy(
                        toastMessage = "Couldn't load payments: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    fun openRecordPayment() { _uiState.value = _uiState.value.copy(showRecordPayment = true) }
    fun closeRecordPayment() { _uiState.value = _uiState.value.copy(showRecordPayment = false) }

    /**
     * Record a payment against this invoice.
     *
     * TWO WRITES, IN THIS ORDER, AND THE ORDER IS THE POINT.
     *
     * FIRST the `markInvoicePaid` callable, which is what actually moves the
     * invoice's money: it writes the audit-grade entry into the invoice's own
     * `payments` SUBCOLLECTION and derives the invoice's state from the SUM of
     * everything recorded there. A partial leaves the invoice OPEN with a real
     * remaining balance, so it stays in Outstanding and the rest can still be
     * collected. Before this, Android recorded payments ONLY into the legacy
     * top-level `payments` collection and never touched the invoice at all, so
     * an invoice paid on the phone stayed fully open forever.
     *
     * THEN the legacy top-level `payments` doc, because this screen's payments
     * list ([InvoiceDetailUiState.linkedPayments], joined on
     * [Payment.invoiceId]) reads that collection and nothing else. It is a
     * display record: the server's arithmetic never reads it, so the two cannot
     * double-count.
     *
     * If the callable fails, NOTHING is written anywhere and the operator is
     * told. A legacy row written against a payment the server refused would be a
     * record of money the books do not believe was collected.
     */
    fun recordPayment(payment: Payment) {
        val invoiceId = _uiState.value.invoice?.id ?: return
        _uiState.value = _uiState.value.copy(recordingPayment = true)
        viewModelScope.launch {
            val settlement = invoiceRepository.markInvoicePaid(
                invoiceId = invoiceId,
                amount = payment.amount,
                method = payment.paymentMethod,
                reference = payment.referenceNumber,
            ).getOrElse { err ->
                _uiState.value = _uiState.value.copy(
                    recordingPayment = false,
                    toastMessage = "Couldn't record payment: ${err.message}",
                    toastVisible = true,
                    toastIsError = true,
                )
                return@launch
            }

            // Best-effort: the money has already landed server-side, so a failure
            // here costs this screen's list row, not the payment. Logged, never
            // swallowed.
            invoiceRepository.createPayment(payment)
                .onFailure { AuntieLog.e("Legacy payment row failed for invoice $invoiceId", it) }

            com.tribetails.auntieos.data.admin.AuditLog.fire(
                scope            = viewModelScope,
                repository       = repository,
                actionType       = "RECORD_PAYMENT",
                description      = recordPaymentAuditDescription(
                    payment.amount,
                    payment.invoiceNumber.ifBlank { invoiceId },
                    settlement,
                ),
                targetId         = invoiceId,
                targetCollection = "invoices",
            )

            loadPaymentsForInvoice(invoiceId)
            // Re-read the invoice so the balance and the chip show what the
            // server actually decided, not what the dialog assumed.
            reloadInvoiceQuietly(invoiceId)
            _uiState.value = _uiState.value.copy(
                recordingPayment = false,
                showRecordPayment = false,
                toastMessage = recordPaymentToast(settlement),
                toastVisible = true,
                toastIsError = false,
            )
        }
    }

    private fun loadSessionsForKinfolk(kinfolkId: String) {
        if (kinfolkId.isBlank()) return
        _uiState.value = _uiState.value.copy(sessionsLoading = true)
        viewModelScope.launch {
            kinCareRepository.getKinCareSessionsForKinfolk(kinfolkId)
                .onSuccess { sessions ->
                    _uiState.value = _uiState.value.copy(
                        availableSessions = sessions,
                        sessionsLoading   = false,
                    )
                }
                .onFailure { err ->
                    AuntieLog.e("Failed to load sessions for kinfolk $kinfolkId", err)
                    _uiState.value = _uiState.value.copy(
                        sessionsLoading = false,
                        toastMessage    = "Could not load sessions: ${err.message}",
                        toastVisible    = true,
                        toastIsError    = true,
                    )
                }
        }
    }

    fun openEditMode() {
        val current = _uiState.value.invoice?.sessionIds?.toSet() ?: emptySet()
        _uiState.value = _uiState.value.copy(editMode = true, pendingSessionIds = current)
    }

    fun closeEditMode() {
        _uiState.value = _uiState.value.copy(editMode = false)
    }

    fun toggleSessionInPending(sessionId: String) {
        val pending = _uiState.value.pendingSessionIds.toMutableSet()
        if (sessionId in pending) pending.remove(sessionId) else pending.add(sessionId)
        _uiState.value = _uiState.value.copy(pendingSessionIds = pending)
    }

    fun saveLinks() {
        val invoiceId  = _uiState.value.invoice?.id ?: return
        val newIds     = _uiState.value.pendingSessionIds.toList()

        _uiState.value = _uiState.value.copy(saveLoading = true)
        viewModelScope.launch {
            // ONE callable owns both directions (W2-2 of ADR-0002): the invoice's
            // sessionIds and every touched session's invoiceId change together in
            // one server transaction, or not at all. The added/removed delta the
            // old code computed here is derived server-side against the STORED
            // set, so two concurrent saves cannot both work from the same stale
            // snapshot, and a mid-loop session failure can no longer strand the
            // invoice claiming a session that still points elsewhere.
            val linkResult = invoiceRepository.linkInvoiceSessions(invoiceId, newIds)
            if (linkResult.isFailure) {
                AuntieLog.e("Failed to link sessions for invoice $invoiceId", linkResult.exceptionOrNull())
                _uiState.value = _uiState.value.copy(
                    saveLoading  = false,
                    toastMessage = "Save failed: ${linkResult.exceptionOrNull()?.message}",
                    toastVisible = true,
                    toastIsError = true,
                )
                return@launch
            }

            // Refresh invoice to pick up new sessionIds + attribution + persisted state
            invoiceRepository.getInvoiceById(invoiceId)
                .onSuccess { refreshed ->
                    _uiState.value = _uiState.value.copy(
                        invoice      = refreshed,
                        saveLoading  = false,
                        editMode     = false,
                        toastMessage = "Sessions linked.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure {
                    // Save succeeded even if re-fetch failed - dismiss edit mode
                    _uiState.value = _uiState.value.copy(
                        saveLoading  = false,
                        editMode     = false,
                        toastMessage = "Sessions linked (refresh failed).",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
        }
    }

    /**
     * Stage 2 tail: generate a receipt for this invoice via the generateReceipt
     * callable. Reloads the invoice on success so any status flip is reflected.
     */
    fun generateReceipt() {
        val invoiceId = _uiState.value.invoice?.id ?: return
        if (_uiState.value.generatingReceipt) return
        _uiState.value = _uiState.value.copy(generatingReceipt = true)
        viewModelScope.launch {
            invoiceRepository.generateReceipt(invoiceId)
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = "GENERATE_RECEIPT",
                        description      = "Generated receipt for invoice ${_uiState.value.invoice?.invoiceNumber?.ifBlank { invoiceId } ?: invoiceId}",
                        targetId         = invoiceId,
                        targetCollection = "invoices",
                    )
                    reloadInvoiceQuietly(invoiceId)
                    _uiState.value = _uiState.value.copy(
                        generatingReceipt = false,
                        toastMessage = "Receipt generated.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure { err ->
                    _uiState.value = _uiState.value.copy(
                        generatingReceipt = false,
                        toastMessage = "Couldn't generate receipt: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    /** Stage 3 / 16.2: render + download the invoice PDF, then hand the URL to the
     *  screen (pdfUrlToOpen) which opens it via an Intent. Fail-loud on error. */
    fun downloadPdf() {
        val invoiceId = _uiState.value.invoice?.id ?: return
        if (_uiState.value.generatingPdf) return
        _uiState.value = _uiState.value.copy(generatingPdf = true)
        viewModelScope.launch {
            invoiceRepository.generateInvoicePdf(invoiceId)
                .onSuccess { url ->
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = "DOWNLOAD_INVOICE_PDF",
                        description      = "Downloaded PDF for invoice ${_uiState.value.invoice?.invoiceNumber?.ifBlank { invoiceId } ?: invoiceId}",
                        targetId         = invoiceId,
                        targetCollection = "invoices",
                    )
                    _uiState.value = _uiState.value.copy(
                        generatingPdf = false,
                        pdfUrlToOpen = url,
                        toastMessage = "Opening invoice PDF.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure { err ->
                    _uiState.value = _uiState.value.copy(
                        generatingPdf = false,
                        toastMessage = "Couldn't make the PDF: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    /** Clears the one-shot PDF URL after the screen has opened it. */
    fun consumePdfUrl() { _uiState.value = _uiState.value.copy(pdfUrlToOpen = null) }

    /** Fail-loud when no app can open the PDF URL (Intent threw on the screen). */
    fun pdfOpenFailed() {
        _uiState.value = _uiState.value.copy(
            toastMessage = "No app available to open the PDF.",
            toastVisible = true,
            toastIsError = true,
        )
    }

    /**
     * Stage 2 tail: send an on-demand payment reminder for this invoice via the
     * sendInvoiceReminder callable. Fail-loud: server preconditions (already-paid,
     * not-found) surface verbatim in the toast.
     */
    fun sendReminder() {
        val invoiceId = _uiState.value.invoice?.id ?: return
        if (_uiState.value.sendingReminder) return
        _uiState.value = _uiState.value.copy(sendingReminder = true)
        viewModelScope.launch {
            invoiceRepository.sendInvoiceReminder(invoiceId)
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = "SEND_INVOICE_REMINDER",
                        description      = "Sent payment reminder for invoice ${_uiState.value.invoice?.invoiceNumber?.ifBlank { invoiceId } ?: invoiceId}",
                        targetId         = invoiceId,
                        targetCollection = "invoices",
                    )
                    _uiState.value = _uiState.value.copy(
                        sendingReminder = false,
                        toastMessage = "Reminder sent.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure { err ->
                    _uiState.value = _uiState.value.copy(
                        sendingReminder = false,
                        toastMessage = "Couldn't send reminder: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    /* ------------------------------------------------------- Task 5.1 archive */

    /** Opens the archive/restore confirm. Nothing is sent until it is confirmed. */
    fun promptArchive() {
        _uiState.value = _uiState.value.copy(archivePrompt = true, archiveForceOffered = false)
    }

    fun dismissArchivePrompt() {
        if (_uiState.value.archiving) return
        _uiState.value = _uiState.value.copy(archivePrompt = false, archiveForceOffered = false)
    }

    /**
     * Archives or restores the invoice, depending on which state it is in.
     *
     * [force] is only ever true on a SECOND press, after the server has refused
     * because money is still owed. That refusal is not an error to report and
     * move on from: it is a decision to hand back to the operator, because
     * archiving an unpaid invoice writes its balance off the outstanding total
     * and nothing will remind anyone to collect it afterwards. So the confirm
     * re-renders with the write-off spelled out rather than closing.
     */
    fun confirmArchive(force: Boolean = false) {
        val invoice = _uiState.value.invoice ?: return
        if (_uiState.value.archiving) return
        val restoring = com.tribetails.auntieos.domain.invoiceIsArchived(invoice)
        _uiState.value = _uiState.value.copy(archiving = true)
        viewModelScope.launch {
            val outcome = if (restoring) {
                invoiceRepository.unarchiveInvoice(invoice.id)
            } else {
                invoiceRepository.archiveInvoice(invoice.id, force)
            }
            outcome
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = if (restoring) "UNARCHIVE_INVOICE" else "ARCHIVE_INVOICE",
                        description      = (if (restoring) "Restored invoice " else "Archived invoice ") +
                            invoice.invoiceNumber.ifBlank { invoice.id } +
                            (if (!restoring && force) " (forced, money still owed)" else ""),
                        targetId         = invoice.id,
                        targetCollection = "invoices",
                    )
                    _uiState.value = _uiState.value.copy(
                        archiving = false,
                        archivePrompt = false,
                        archiveForceOffered = false,
                        toastMessage = archiveSuccessMessage(restoring, force),
                        toastVisible = true,
                        toastIsError = false,
                    )
                    // The doc changed, so the panel must re-read it or it would
                    // go on offering Archive on an invoice that is now archived.
                    reloadInvoiceQuietly(invoice.id)
                }
                .onFailure { err ->
                    val message = err.message.orEmpty()
                    if (!restoring && archiveRefusedForMoneyOwed(message)) {
                        _uiState.value = _uiState.value.copy(
                            archiving = false,
                            archivePrompt = true,
                            archiveForceOffered = true,
                            toastMessage = message,
                            toastVisible = true,
                            toastIsError = true,
                        )
                    } else {
                        _uiState.value = _uiState.value.copy(
                            archiving = false,
                            archivePrompt = false,
                            archiveForceOffered = false,
                            toastMessage = (if (restoring) "Couldn't restore: " else "Couldn't archive: ") + message,
                            toastVisible = true,
                            toastIsError = true,
                        )
                    }
                }
        }
    }

    /**
     * Stage 2 tail: review and send a DRAFT invoice via the postInvoiceEvent callable
     * (status -> "sent"). Reloads the invoice on success so the draft affordance drops.
     */
    fun reviewAndSendDraft() {
        val invoice = _uiState.value.invoice ?: return
        if (_uiState.value.sendingDraft) return
        if (invoice.kinfolkId.isBlank()) {
            _uiState.value = _uiState.value.copy(
                toastMessage = "This invoice has no client (kinfolk) on record, so it cannot be sent.",
                toastVisible = true,
                toastIsError = true,
            )
            return
        }
        _uiState.value = _uiState.value.copy(sendingDraft = true)
        viewModelScope.launch {
            invoiceRepository.reviewAndSendDraftInvoice(invoice.id, invoice.kinfolkId)
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = "SEND_DRAFT_INVOICE",
                        description      = "Reviewed and sent draft invoice ${invoice.invoiceNumber.ifBlank { invoice.id }}",
                        targetId         = invoice.id,
                        targetCollection = "invoices",
                    )
                    reloadInvoiceQuietly(invoice.id)
                    _uiState.value = _uiState.value.copy(
                        sendingDraft = false,
                        toastMessage = "Draft sent.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure { err ->
                    _uiState.value = _uiState.value.copy(
                        sendingDraft = false,
                        toastMessage = "Couldn't send draft: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    /** Re-fetch the invoice into state without flipping the loading shimmer. */
    private fun reloadInvoiceQuietly(invoiceId: String) {
        viewModelScope.launch {
            invoiceRepository.getInvoiceById(invoiceId)
                .onSuccess { refreshed -> _uiState.value = _uiState.value.copy(invoice = refreshed) }
                .onFailure { AuntieLog.e("Quiet reload failed for invoice $invoiceId", it) }
        }
    }

    fun dismissToast() {
        _uiState.value = _uiState.value.copy(toastVisible = false)
    }
}

/**
 * True when an invoice's STORED state stamp reads draft (case-insensitive).
 * Pure; unit-tested. Delegates to the shared stamp decode
 * (domain/InvoiceActions.kt) so this and the Den list's own draft facet can
 * never drift apart - and neither re-derives state from the money.
 */
internal fun isDraftInvoice(invoice: Invoice): Boolean =
    invoiceStateOrNull(invoice) == InvoiceState.DRAFT

/*
 * ORPHANED, REPORTED, NOT DELETED.
 *
 * The two filters below were how this screen built its payment lists out of a
 * raw read of the whole root `payments` collection. That path is gone: the
 * server's `getInvoiceLedger` now does both joins, on rows whose units it has
 * resolved, and the equivalent server code is the AUTHORITY.
 *
 * They are left in place because payment code in this repo is reported rather
 * than cleaned up on a call-graph argument, and their tests
 * (`InvoicePaymentsTest`) still pin the behaviour they describe. Nothing in
 * `main` calls them any more. If they are ever wired back up they will hand a
 * `Payment.amount` to a formatter again, which is the defect this change
 * removed — so the answer to "we need this list on another screen" is another
 * callable field, not these.
 */

/** Payments confidently linked to an invoice via the populated Payment.invoiceId. Pure; tested. */
internal fun paymentsForInvoice(payments: List<Payment>, invoiceId: String): List<Payment> {
    if (invoiceId.isBlank()) return emptyList()
    return payments.filter { it.invoiceId == invoiceId }
}

/**
 * Best-effort payment grouping for the detail screen's DISCLOSED fallback. A Payment
 * carries a kinfolkId but, for legacy/import rows, may lack a per-invoice
 * [Payment.invoiceId] link. This returns same-kinfolk payments that are NOT already
 * linked to a specific invoice, so the UI can surface them under a visible
 * "matched by client only" warning (never implying they belong to THIS invoice).
 * Pure; tested. The server's `unlinkedKinfolkPayments` is now the authority for
 * this list; see the note above.
 */
internal fun unlinkedPaymentsForKinfolk(payments: List<Payment>, kinfolkId: String): List<Payment> {
    if (kinfolkId.isBlank()) return emptyList()
    return payments.filter { it.kinfolkId == kinfolkId && it.invoiceId.isBlank() }
}

/**
 * Build a Payment prefilled from an invoice for the Record-Payment dialog, stamping
 * invoiceId/invoiceNumber so the per-invoice join populates (spec 17 item 6). Pure; tested.
 * Mirrors the web buildInvoicePayment.
 */
internal fun buildInvoicePayment(
    invoice: Invoice,
    amount: Double,
    paymentMethod: String,
    referenceNumber: String,
    date: String,
    notes: String,
    /** GROSS: what the client tipped, before the processor fee. */
    tip: Double = 0.0,
    /** The processor's cut, off the business's proceeds. Not part of [amount]. */
    fee: Double = 0.0,
    /**
     * THE WHOLE SUM THE CLIENT HANDED OVER, when it is more than the applied
     * amount plus the tip. `0.0` means "exactly those two", the ordinary case.
     */
    paymentTotal: Double = 0.0,
    autoApply: Boolean = false,
    sendConfirmationEmail: Boolean = false,
): Payment = Payment(
    kinfolkId = invoice.kinfolkId,
    kinfolkName = invoice.kinfolkName,
    date = date.trim(),
    paymentMethod = paymentMethod.trim(),
    referenceNumber = referenceNumber.trim(),
    // THE TRANSACTION, not the settlement. `markInvoicePaid` settles the invoice
    // with [amount]; this row records what the client actually paid, which is
    // larger whenever there was a tip or money left over.
    amount = if (paymentTotal > 0.0) paymentTotal else amount + tip,
    tip = tip,
    fee = fee,
    notes = notes.trim(),
    invoiceId = invoice.id,
    invoiceNumber = invoice.invoiceNumber,
    autoApply = autoApply,
    sendConfirmationEmail = sendConfirmationEmail,
)
/**
 * Did the server refuse this archive because money is still owed, as opposed to
 * any other failure?
 *
 * MATCHED ON THE MESSAGE, WITH A REASON. The Android Functions SDK surfaces a
 * callable's `details` payload only through a `FirebaseFunctionsException`, and
 * this repository deliberately flattens every callable to `Result<T>` so no
 * caller has to know that; the `details.code` of `invoice_still_owing` is
 * therefore not reachable here without unwinding that seam for one branch. The
 * consequence of a false negative is mild and safe: the operator sees the
 * server's own sentence and can press Archive again, rather than being offered
 * the write-off in one step. A false POSITIVE cannot make anything happen on
 * its own, because forcing still requires a second, explicit press.
 *
 * Pure, so the phrasing this depends on is pinned by a test rather than by hope.
 */
internal fun archiveRefusedForMoneyOwed(message: String): Boolean =
    message.contains("owing", ignoreCase = true) || message.contains("outstanding total", ignoreCase = true)
/**
 * The toast for a completed archive or restore.
 *
 * A FORCED archive says what was actually given up, rather than reporting the
 * same bland success as an ordinary one. The operator has just written a real
 * balance off the outstanding total and nothing will chase it again.
 */
internal fun archiveSuccessMessage(restoring: Boolean, force: Boolean): String = when {
    restoring -> "Invoice restored to the working list."
    force -> "Invoice archived, and the balance written off the outstanding total."
    else -> "Invoice archived."
}
/**
 * WHAT THE SERVER SAYS HAPPENED, in the operator's words. Pure; unit-tested.
 *
 * Never "Payment recorded." alone for a partial. Reporting a payment that
 * covered half an invoice as if the invoice were done is the UI half of the
 * defect this whole change exists to remove: the operator had no way to tell,
 * from the screen, that a balance was still owed.
 *
 * A BLANK `state` GETS ITS OWN SENTENCE, and that branch is where ADR-0001
 * adoption put a ruling the deleted `decodeInvoiceSettlement` used to make in
 * the wire decoder. That decoder answered an unreadable payload with "partial",
 * which meant this function said "$0.00 is still owed" - a settlement figure
 * nobody sent. The generated decoder answers `""` instead, and `""` is not one
 * of the four states the server can send, so the only honest thing to say is
 * that the invoice's new position is unknown. It must not fall through to
 * "paid in full": that is the very claim the 2026-07-25 fix exists to stop the
 * app making on its own.
 */
internal fun recordPaymentToast(settlement: MarkInvoicePaidResult): String = when (settlement.state) {
    "partial" ->
        "Partial payment recorded. ${formatCentsUsd(settlement.amountDueCents)} is still owed, and the invoice stays open."
    "overpaid" ->
        "Payment recorded and the invoice is settled. It was overpaid by ${formatCentsUsd(settlement.overpaidCents)}, which has not been turned into a credit."
    "" ->
        "Payment recorded. The server did not report where the invoice now stands, so open it to check what is still owed."
    else -> "Payment recorded. The invoice is paid in full."
}
/**
 * The audit line for one recorded payment. Says whether the invoice was settled
 * or merely part-paid, so the audit trail cannot claim "paid" about an invoice
 * that is not. Pure; unit-tested.
 *
 * The blank-state branch is the same ruling as [recordPaymentToast]'s, and it
 * matters more here: an audit line is read back months later by someone with no
 * other record of the call, so "settled" written on a response that never said
 * so is a false entry rather than a stale toast.
 */
internal fun recordPaymentAuditDescription(
    amount: Double,
    invoiceLabel: String,
    settlement: MarkInvoicePaidResult,
): String = when (settlement.state) {
    "partial" ->
        "Recorded partial payment of $amount against invoice $invoiceLabel; ${formatCentsUsd(settlement.amountDueCents)} still owed"
    "" ->
        "Recorded payment of $amount against invoice $invoiceLabel; the server did not report the resulting balance"
    else -> "Recorded payment of $amount against invoice $invoiceLabel; invoice settled"
}
