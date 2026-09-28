package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResult
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultPayment
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.mintUnappliedDecisionIdempotencyKey
import com.tribetails.auntieos.domain.DecideForm
import com.tribetails.auntieos.domain.decisionResultText
import com.tribetails.auntieos.domain.parseDecideForm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val UNAPPLIED_LOAD_ERROR = "Could not load payments needing a decision."
const val UNAPPLIED_EMPTY_FROM_NOTICE = "No card payments are waiting for a decision."

data class UnappliedPaymentsUiState(
    val kinfolkId: String = "",
    /** False once the server refused the read with permission-denied: the sub-section hides. */
    val visible: Boolean = true,
    val loading: Boolean = false,
    val result: ListUnappliedPaymentsResult? = null,
    val loadError: String? = null,
    /** Opened from the `invoice.payment.unapplied` notice: an empty list still says so. */
    val fromNotice: Boolean = false,
    /** The payment whose Decide dialog is open, or null when it is closed. */
    val dialogPaymentId: String? = null,
    val creditText: String = "",
    val reasonText: String = "",
    /** "" is None. */
    val applyInvoiceId: String = "",
    val applyText: String = "",
    val busy: Boolean = false,
    /** The server's refusal of the last save, shown in the dialog as is. */
    val saveError: String? = null,
    /** The one-shot note after a save. */
    val message: String? = null,
) {
    val payments: List<ListUnappliedPaymentsResultPayment> get() = result?.payments.orEmpty()

    val dialogPayment: ListUnappliedPaymentsResultPayment?
        get() = dialogPaymentId?.let { id -> payments.firstOrNull { it.paymentId == id } }

    /** The dialog's form, read fresh from the four inputs. Null with no dialog open. */
    val form: DecideForm?
        get() {
            val p = dialogPayment ?: return null
            return parseDecideForm(
                paymentCents = p.amountCents,
                openInvoices = result?.openInvoices.orEmpty(),
                creditText = creditText,
                reasonText = reasonText,
                applyInvoiceId = applyInvoiceId,
                applyText = applyText,
            )
        }

    /** The sub-section shows while there is something to decide, or when the notice sent the operator here. */
    val showSection: Boolean
        get() = visible && (payments.isNotEmpty() || fromNotice || (loadError != null && result == null))
}

/**
 * #1003: "Payments needing a decision" inside the household profile's Account
 * credit section, and its Decide dialog. A plain class over a scope, like
 * [AccountCreditController], so [DirectoryViewModel] owns it and a test drives
 * it with a test scope.
 *
 * THE KEY IS PER SUBMISSION. Minted on the first Save press, kept through a
 * failed save so the retry lands on the same decision, and dropped on success,
 * on close, and whenever any of the four inputs changes.
 *
 * Builds a request only. [save] sends the payment id plus what the four form
 * fields parse to; no stored payment, invoice or household model is rebuilt
 * from form state or written back, so no field can be wiped by a save here.
 */
class UnappliedPaymentsController(
    private val invoiceRepository: InvoiceRepository,
    private val scope: CoroutineScope,
    private val mintKey: () -> String = { mintUnappliedDecisionIdempotencyKey() },
    /** After a save: the credit part lands on the credit ledger, so the Account credit panel reloads. */
    private val onSaved: (kinfolkId: String) -> Unit = {},
) {
    private val _state = MutableStateFlow(UnappliedPaymentsUiState())
    val state: StateFlow<UnappliedPaymentsUiState> = _state.asStateFlow()

    /** The key for the submission on screen, or null when there is none yet. */
    internal var pendingKey: String? = null
        private set

    /** Set by the notice link before the profile opens; consumed by the next [load] of that household. */
    private var noticeTarget: Pair<String, String>? = null

    /**
     * The `invoice.payment.unapplied` notice: the profile about to open should
     * show this list, and open [paymentId]'s dialog if it is in it.
     */
    fun openFromNotice(kinfolkId: String, paymentId: String) {
        noticeTarget = kinfolkId to paymentId
    }

    fun load(kinfolkId: String) {
        val notice = noticeTarget?.takeIf { it.first == kinfolkId }
        noticeTarget = null
        if (_state.value.kinfolkId != kinfolkId) {
            pendingKey = null
            _state.value = UnappliedPaymentsUiState(kinfolkId = kinfolkId, fromNotice = notice != null)
        } else {
            // A plain visit to the same household is not the notice any more.
            _state.update { it.copy(fromNotice = notice != null) }
        }
        fetch(kinfolkId, focusPaymentId = notice?.second)
    }

    /** Retry after a load failure, and the refresh after a save. */
    fun reload() {
        val id = _state.value.kinfolkId
        if (id.isNotBlank()) fetch(id, focusPaymentId = null)
    }

    private fun fetch(kinfolkId: String, focusPaymentId: String?) {
        _state.update { it.copy(loading = true, loadError = null) }
        scope.launch {
            invoiceRepository.listUnappliedPayments(kinfolkId).fold(
                onSuccess = { res ->
                    if (_state.value.kinfolkId != kinfolkId) return@fold
                    _state.update { it.copy(loading = false, result = res, visible = true) }
                    val focus = focusPaymentId?.takeIf { id -> id.isNotBlank() && res.payments.any { it.paymentId == id } }
                    if (focus != null) open(focus)
                },
                onFailure = { err ->
                    if (_state.value.kinfolkId != kinfolkId) return@fold
                    if (isPermissionDenied(err)) {
                        _state.update { it.copy(loading = false, visible = false) }
                    } else {
                        _state.update { it.copy(loading = false, loadError = UNAPPLIED_LOAD_ERROR) }
                    }
                },
            )
        }
    }

    /** Decide on one payment: a fresh, empty form. */
    fun open(paymentId: String) {
        if (_state.value.busy) return
        pendingKey = null
        _state.update {
            it.copy(
                dialogPaymentId = paymentId,
                creditText = "",
                reasonText = "",
                applyInvoiceId = "",
                applyText = "",
                saveError = null,
            )
        }
    }

    /** Cancel and the scrim. Refused while a save is in flight. */
    fun dismiss() {
        if (_state.value.busy) return
        pendingKey = null
        _state.update { it.copy(dialogPaymentId = null, saveError = null) }
    }

    private fun edit(change: (UnappliedPaymentsUiState) -> UnappliedPaymentsUiState) {
        val before = _state.value
        if (before.busy || before.dialogPaymentId == null) return
        val after = change(before)
        if (after != before) {
            // Any changed input makes it a different submission.
            pendingKey = null
            _state.value = after.copy(saveError = null)
        }
    }

    fun setCredit(text: String) = edit { it.copy(creditText = text) }
    fun setReason(text: String) = edit { it.copy(reasonText = text) }
    fun setApplyInvoice(invoiceId: String) = edit { it.copy(applyInvoiceId = invoiceId) }
    fun setApply(text: String) = edit { it.copy(applyText = text) }

    fun save() {
        val s = _state.value
        if (s.busy) return
        val payment = s.dialogPayment ?: return
        val form = s.form as? DecideForm.Ready ?: return
        val key = pendingKey ?: mintKey().also { pendingKey = it }
        _state.update { it.copy(busy = true, saveError = null) }
        scope.launch {
            invoiceRepository.resolveUnappliedPayment(
                paymentId = payment.paymentId,
                creditCents = form.creditCents,
                creditReason = form.creditReason,
                applyInvoiceId = form.applyInvoiceId,
                applyCents = form.applyCents,
                idempotencyKey = key,
            ).fold(
                onSuccess = { res ->
                    pendingKey = null
                    _state.update {
                        it.copy(busy = false, dialogPaymentId = null, message = decisionResultText(res))
                    }
                    reload()
                    onSaved(s.kinfolkId)
                },
                onFailure = { err ->
                    // The key is KEPT: pressing Save again is a retry of this
                    // same submission, and the server answers it from the stored
                    // decision if the first attempt landed.
                    _state.update { it.copy(busy = false, saveError = unappliedSaveErrorText(err)) }
                },
            )
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }
}

/** The server's message, as is. */
internal fun unappliedSaveErrorText(err: Throwable): String =
    err.message?.takeIf { it.isNotBlank() } ?: err.javaClass.simpleName
