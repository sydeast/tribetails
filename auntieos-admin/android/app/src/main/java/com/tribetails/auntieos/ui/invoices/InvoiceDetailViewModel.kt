package com.tribetails.auntieos.ui.invoices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.invoiceStateOf
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
    // Payments (spec 17 items 5/6): real per-invoice join via Payment.invoiceId.
    val linkedPayments: List<Payment> = emptyList(),
    // Stage 2 Step 2: disclosed client-side fallback. Same-kinfolk payments with no
    // invoiceId link, shown under a visible "matched by client only" warning when
    // there is no confident per-invoice payment yet.
    val clientPayments: List<Payment> = emptyList(),
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

class InvoiceDetailViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(InvoiceDetailUiState())
    val uiState: StateFlow<InvoiceDetailUiState> = _uiState.asStateFlow()

    fun loadInvoice(invoiceId: String) {
        _uiState.value = InvoiceDetailUiState(isLoading = true)
        viewModelScope.launch {
            repository.getInvoiceById(invoiceId)
                .onSuccess { invoice ->
                    _uiState.value = _uiState.value.copy(
                        invoice   = invoice,
                        isLoading = false,
                        error     = null,
                    )
                    loadSessionsForKinfolk(invoice.kinfolkId)
                    loadPaymentsForInvoice(invoice.id, invoice.kinfolkId)
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

    /**
     * Load payments confidently linked to this invoice via the populated
     * Payment.invoiceId, plus the disclosed client-side fallback (same-kinfolk
     * payments with no invoiceId link) so the UI can offer it under a visible
     * "matched by client only" warning. Fail-loud: a load failure surfaces in the toast.
     */
    /** A8 Payments: fetch the operator's payment handles for the "How to pay" section.
     *  Fail-soft: if it can't load, the section simply doesn't render (no fake handles). */
    private fun loadBusinessSettings() {
        viewModelScope.launch {
            repository.getBusinessSettings().onSuccess { bs ->
                _uiState.value = _uiState.value.copy(businessSettings = bs)
            }
        }
    }

    private fun loadPaymentsForInvoice(invoiceId: String, kinfolkId: String) {
        if (invoiceId.isBlank()) return
        viewModelScope.launch {
            repository.getPayments()
                .onSuccess { all ->
                    _uiState.value = _uiState.value.copy(
                        linkedPayments = paymentsForInvoice(all, invoiceId),
                        clientPayments = unlinkedPaymentsForKinfolk(all, kinfolkId),
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

    /** Record a payment against this invoice (writes Payment.invoiceId so the join populates). */
    fun recordPayment(payment: Payment) {
        val invoiceId = _uiState.value.invoice?.id ?: return
        _uiState.value = _uiState.value.copy(recordingPayment = true)
        viewModelScope.launch {
            repository.createPayment(payment)
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = repository,
                        actionType       = "RECORD_PAYMENT",
                        description      = "Recorded payment of ${payment.amount} against invoice ${payment.invoiceNumber.ifBlank { invoiceId }}",
                        targetId         = invoiceId,
                        targetCollection = "invoices",
                    )
                    loadPaymentsForInvoice(invoiceId, _uiState.value.invoice?.kinfolkId.orEmpty())
                    _uiState.value = _uiState.value.copy(
                        recordingPayment = false,
                        showRecordPayment = false,
                        toastMessage = "Payment recorded.",
                        toastVisible = true,
                        toastIsError = false,
                    )
                }
                .onFailure { err ->
                    _uiState.value = _uiState.value.copy(
                        recordingPayment = false,
                        toastMessage = "Couldn't record payment: ${err.message}",
                        toastVisible = true,
                        toastIsError = true,
                    )
                }
        }
    }

    private fun loadSessionsForKinfolk(kinfolkId: String) {
        if (kinfolkId.isBlank()) return
        _uiState.value = _uiState.value.copy(sessionsLoading = true)
        viewModelScope.launch {
            repository.getKinCareSessionsForKinfolk(kinfolkId)
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
        val oldIds     = _uiState.value.invoice?.sessionIds?.toSet() ?: emptySet()
        val added      = newIds.toSet() - oldIds
        val removed    = oldIds - newIds.toSet()

        _uiState.value = _uiState.value.copy(saveLoading = true)
        viewModelScope.launch {
            // 1. Write invoice.sessionIds + flip attribution to "manual"
            val invoiceResult = repository.updateInvoiceSessionIds(invoiceId, newIds)
            if (invoiceResult.isFailure) {
                AuntieLog.e("Failed to update invoice sessionIds for $invoiceId", invoiceResult.exceptionOrNull())
                _uiState.value = _uiState.value.copy(
                    saveLoading  = false,
                    toastMessage = "Save failed: ${invoiceResult.exceptionOrNull()?.message}",
                    toastVisible = true,
                    toastIsError = true,
                )
                return@launch
            }

            // 2. Bidirectional sync: set invoiceId on newly linked sessions
            added.forEach { sid ->
                val r = repository.updateSessionInvoiceId(sid, invoiceId)
                if (r.isFailure) {
                    AuntieLog.e("Failed to link session $sid → invoice $invoiceId", r.exceptionOrNull())
                }
            }
            // 3. Clear invoiceId on unlinked sessions
            removed.forEach { sid ->
                val r = repository.updateSessionInvoiceId(sid, "")
                if (r.isFailure) {
                    AuntieLog.e("Failed to unlink session $sid from invoice $invoiceId", r.exceptionOrNull())
                }
            }

            // 4. Refresh invoice to pick up new sessionIds + attribution
            repository.getInvoiceById(invoiceId)
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
            repository.generateReceipt(invoiceId)
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
            repository.generateInvoicePdf(invoiceId)
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
            repository.sendInvoiceReminder(invoiceId)
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
                repository.unarchiveInvoice(invoice.id)
            } else {
                repository.archiveInvoice(invoice.id, force)
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
            repository.reviewAndSendDraftInvoice(invoice.id, invoice.kinfolkId)
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
            repository.getInvoiceById(invoiceId)
                .onSuccess { refreshed -> _uiState.value = _uiState.value.copy(invoice = refreshed) }
                .onFailure { AuntieLog.e("Quiet reload failed for invoice $invoiceId", it) }
        }
    }

    fun dismissToast() {
        _uiState.value = _uiState.value.copy(toastVisible = false)
    }
}

/**
 * True when an invoice is still a draft (case-insensitive). Pure; unit-tested.
 * Delegates to the shared classifier (domain/InvoiceActions.kt) so this and the
 * Den list's own draft facet can never drift apart.
 */
internal fun isDraftInvoice(invoice: Invoice): Boolean =
    invoiceStateOf(invoice) == InvoiceState.DRAFT

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
 * Pure; tested. Mirrors the web paymentsForKinfolk, scoped to the unlinked subset.
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
): Payment = Payment(
    kinfolkId = invoice.kinfolkId,
    kinfolkName = invoice.kinfolkName,
    date = date.trim(),
    paymentMethod = paymentMethod.trim(),
    referenceNumber = referenceNumber.trim(),
    amount = amount,
    notes = notes.trim(),
    invoiceId = invoice.id,
    invoiceNumber = invoice.invoiceNumber,
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
