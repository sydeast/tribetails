package com.tribetails.auntieos.ui.invoices

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.ApplyAccountCreditResult
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.mintApplyCreditIdempotencyKey
import com.tribetails.auntieos.domain.ApplyCreditForm
import com.tribetails.auntieos.domain.creditAppliedText
import com.tribetails.auntieos.domain.parseApplyCreditAmount
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Where the Account credit box is: the amount field, or the confirmation. */
enum class ApplyCreditStep { Edit, Confirm }

data class ApplyCreditUiState(
    val invoiceId: String = "",
    val kinfolkId: String = "",
    /** False once the server refused the read with permission-denied: the section hides. */
    val visible: Boolean = true,
    val loading: Boolean = false,
    /** The household's available credit, or null until it has been read. */
    val availableCents: Long? = null,
    val loadError: String? = null,
    val amountText: String = "",
    /** A refusal from the box or the server, shown directly under the field. */
    val fieldError: String? = null,
    val step: ApplyCreditStep = ApplyCreditStep.Edit,
    /** The parsed amount on the Confirm step. */
    val pendingAmountCents: Long = 0L,
    val busy: Boolean = false,
)

/**
 * #1872 (operator ruling 2026-11-11): ACCOUNT CREDIT IS NEVER SPENT
 * AUTOMATICALLY. It goes onto an invoice only here, as an amount the admin
 * types and confirms. A plain class over a scope, owned by
 * [InvoiceDetailViewModel], so a test drives it with a test scope.
 *
 * THE KEY IS PER SUBMISSION. Minted when she confirms, kept through a failed
 * attempt so pressing Apply credit again lands on the same payment (a lost
 * reply cannot apply the amount twice), and dropped on success or when the
 * amount changes, which makes it a different submission.
 *
 * Owner only. An Auntie never sees money: the balance read is refused for her
 * and the whole section hides.
 *
 * Builds a request only. No stored model is rebuilt from form state.
 */
class InvoiceApplyCreditController(
    private val invoiceRepository: InvoiceRepository,
    private val scope: CoroutineScope,
    private val mintKey: () -> String = { mintApplyCreditIdempotencyKey() },
    /** Credit moved: the server's answer and the sentence that says so. */
    private val onApplied: (ApplyAccountCreditResult, String) -> Unit = { _, _ -> },
) {
    private val _state = MutableStateFlow(ApplyCreditUiState())
    val state: StateFlow<ApplyCreditUiState> = _state.asStateFlow()

    /** The key for the submission on screen, or null when there is none yet. */
    internal var pendingKey: String? = null
        private set

    /** Reads the household's available credit for this invoice's box. */
    fun load(invoiceId: String, kinfolkId: String) {
        val s = _state.value
        if (s.invoiceId != invoiceId || s.kinfolkId != kinfolkId) {
            pendingKey = null
            _state.value = ApplyCreditUiState(invoiceId = invoiceId, kinfolkId = kinfolkId)
        }
        if (kinfolkId.isBlank()) {
            _state.update { it.copy(visible = false, loading = false) }
            return
        }
        _state.update { it.copy(loading = true, loadError = null) }
        scope.launch {
            invoiceRepository.getAccountCreditHistory(kinfolkId).fold(
                onSuccess = { h ->
                    if (_state.value.kinfolkId == kinfolkId) {
                        _state.update {
                            it.copy(
                                loading = false,
                                visible = true,
                                availableCents = h.accountBalanceCents.coerceAtLeast(0L),
                            )
                        }
                    }
                },
                onFailure = { err ->
                    if (_state.value.kinfolkId != kinfolkId) return@fold
                    if (isApplyCreditPermissionDenied(err)) {
                        _state.update { it.copy(loading = false, visible = false) }
                    } else {
                        _state.update { it.copy(loading = false, loadError = "Couldn't load account credit.") }
                    }
                },
            )
        }
    }

    /** Try again, for a failed balance read. */
    fun retryLoad() {
        val s = _state.value
        load(s.invoiceId, s.kinfolkId)
    }

    fun setAmount(text: String) {
        if (_state.value.busy) return
        if (text != _state.value.amountText) pendingKey = null
        _state.update { it.copy(amountText = text, fieldError = null) }
    }

    /** Apply credit on the form: check the amount, then show the confirmation. */
    fun review(dueCents: Long?) {
        val s = _state.value
        if (s.busy) return
        val available = s.availableCents ?: return
        when (val form = parseApplyCreditAmount(s.amountText, available, dueCents)) {
            is ApplyCreditForm.Invalid -> _state.update { it.copy(fieldError = form.message) }
            is ApplyCreditForm.Ready ->
                _state.update {
                    it.copy(step = ApplyCreditStep.Confirm, pendingAmountCents = form.amountCents, fieldError = null)
                }
        }
    }

    /** Back from the confirmation to the field. Refused while the call is in flight. */
    fun back() {
        if (_state.value.busy) return
        _state.update { it.copy(step = ApplyCreditStep.Edit) }
    }

    fun confirm(invoiceNumber: String?) {
        val s = _state.value
        if (s.busy || s.step != ApplyCreditStep.Confirm) return
        val key = pendingKey ?: mintKey().also { pendingKey = it }
        _state.update { it.copy(busy = true, fieldError = null) }
        scope.launch {
            invoiceRepository.applyAccountCredit(s.invoiceId, s.pendingAmountCents, key).fold(
                onSuccess = { res ->
                    pendingKey = null
                    _state.update {
                        it.copy(
                            busy = false,
                            step = ApplyCreditStep.Edit,
                            amountText = "",
                            // The server's balance, shown at once; the read below confirms it.
                            availableCents = res.accountBalanceCents.coerceAtLeast(0L),
                        )
                    }
                    onApplied(
                        res,
                        creditAppliedText(res.appliedCents, res.amountDueCents, res.accountBalanceCents, invoiceNumber),
                    )
                    load(s.invoiceId, s.kinfolkId)
                },
                onFailure = { err ->
                    // The key is KEPT: pressing Apply credit again with the same
                    // amount is a retry of this submission, and the server
                    // answers it from the stored payment if the first landed.
                    // The server's refusal is already in plain words; it goes
                    // under the field, and the form comes back.
                    _state.update {
                        it.copy(busy = false, step = ApplyCreditStep.Edit, fieldError = applyCreditErrorText(err))
                    }
                    // What she holds or owes may have moved under her: read it again.
                    load(s.invoiceId, s.kinfolkId)
                },
            )
        }
    }
}

internal fun isApplyCreditPermissionDenied(err: Throwable): Boolean =
    (err as? FirebaseFunctionsException)?.code == FirebaseFunctionsException.Code.PERMISSION_DENIED

/** The server's own words when it sent any, since they are written for this field. */
internal fun applyCreditErrorText(err: Throwable): String =
    err.message?.takeIf { it.isNotBlank() } ?: "Couldn't apply credit. Try again."
