package com.tribetails.auntieos.ui.directory

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResult
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.mintGiveCreditIdempotencyKey
import com.tribetails.auntieos.domain.GiveCreditForm
import com.tribetails.auntieos.domain.giveCreditSuccessText
import com.tribetails.auntieos.domain.parseGiveCreditForm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Where the Give credit dialog is. */
enum class GiveCreditStep { Closed, Edit, Confirm }

data class AccountCreditUiState(
    val kinfolkId: String = "",
    /** False once the server refused the read with permission-denied: the section hides. */
    val visible: Boolean = true,
    val loading: Boolean = false,
    val history: GetAccountCreditHistoryResult? = null,
    val loadError: String? = null,
    val step: GiveCreditStep = GiveCreditStep.Closed,
    val amountText: String = "",
    val reasonText: String = "",
    /** A refusal from the form or the server, shown in the dialog. */
    val formError: String? = null,
    /** The parsed amount on the Confirm step. */
    val pendingAmountCents: Long = 0L,
    val pendingReason: String = "",
    val busy: Boolean = false,
    /** The one-shot note after a save. */
    val message: String? = null,
)

/**
 * Q6: the household profile's Account credit section and its Give credit
 * dialog. A plain class over a scope rather than a second ViewModel, so
 * [DirectoryViewModel] owns it and a test drives it with a test scope.
 *
 * THE KEY IS PER SUBMISSION. It is minted when the form first reaches Confirm,
 * kept through a failed save so the operator's retry reuses it (a lost reply
 * cannot add the credit twice), and dropped on success or when the amount or
 * reason changes, which makes it a different submission.
 *
 * Builds a request only. No stored model is rebuilt from form state, so no
 * field can be wiped by a save here.
 */
class AccountCreditController(
    private val invoiceRepository: InvoiceRepository,
    private val scope: CoroutineScope,
    private val mintKey: () -> String = { mintGiveCreditIdempotencyKey() },
) {
    private val _state = MutableStateFlow(AccountCreditUiState())
    val state: StateFlow<AccountCreditUiState> = _state.asStateFlow()

    /** The key for the submission on screen, or null when there is none yet. */
    internal var pendingKey: String? = null
        private set

    fun load(kinfolkId: String) {
        if (_state.value.kinfolkId != kinfolkId) {
            pendingKey = null
            _state.value = AccountCreditUiState(kinfolkId = kinfolkId)
        }
        _state.update { it.copy(loading = true, loadError = null) }
        scope.launch {
            invoiceRepository.getAccountCreditHistory(kinfolkId).fold(
                onSuccess = { h ->
                    if (_state.value.kinfolkId == kinfolkId) {
                        _state.update { it.copy(loading = false, history = h, visible = true) }
                    }
                },
                onFailure = { err ->
                    if (_state.value.kinfolkId != kinfolkId) return@fold
                    if (isPermissionDenied(err)) {
                        _state.update { it.copy(loading = false, visible = false) }
                    } else {
                        _state.update { it.copy(loading = false, loadError = "Couldn't load account credit.") }
                    }
                },
            )
        }
    }

    fun open() {
        if (_state.value.busy) return
        pendingKey = null
        _state.update {
            it.copy(step = GiveCreditStep.Edit, amountText = "", reasonText = "", formError = null)
        }
    }

    /** Cancel and the scrim. Refused while a save is in flight. */
    fun dismiss() {
        if (_state.value.busy) return
        pendingKey = null
        _state.update { it.copy(step = GiveCreditStep.Closed, formError = null) }
    }

    fun setAmount(text: String) {
        if (_state.value.busy) return
        if (text != _state.value.amountText) pendingKey = null
        _state.update { it.copy(amountText = text, formError = null) }
    }

    fun setReason(text: String) {
        if (_state.value.busy) return
        if (text != _state.value.reasonText) pendingKey = null
        _state.update { it.copy(reasonText = text, formError = null) }
    }

    /** Review: validate, then show the confirmation. */
    fun review() {
        val s = _state.value
        if (s.busy) return
        when (val form = parseGiveCreditForm(s.amountText, s.reasonText)) {
            is GiveCreditForm.Invalid -> _state.update { it.copy(formError = form.message) }
            is GiveCreditForm.Ready -> {
                if (pendingKey == null) pendingKey = mintKey()
                _state.update {
                    it.copy(
                        step = GiveCreditStep.Confirm,
                        pendingAmountCents = form.amountCents,
                        pendingReason = form.reason,
                        formError = null,
                    )
                }
            }
        }
    }

    /** Back from the confirmation to the fields. The key stays: nothing changed yet. */
    fun back() {
        if (_state.value.busy) return
        _state.update { it.copy(step = GiveCreditStep.Edit, formError = null) }
    }

    fun confirm() {
        val s = _state.value
        if (s.busy || s.step != GiveCreditStep.Confirm) return
        val key = pendingKey ?: mintKey().also { pendingKey = it }
        _state.update { it.copy(busy = true, formError = null) }
        scope.launch {
            invoiceRepository.giveAccountCredit(s.kinfolkId, s.pendingAmountCents, s.pendingReason, key).fold(
                onSuccess = { res ->
                    pendingKey = null
                    _state.update {
                        it.copy(
                            busy = false,
                            step = GiveCreditStep.Closed,
                            message = giveCreditSuccessText(res.newAccountBalanceCents),
                        )
                    }
                    load(s.kinfolkId)
                },
                onFailure = { err ->
                    // The key is KEPT: pressing Give credit again is a retry of
                    // this same submission, and the server answers it from the
                    // stored credit if the first attempt landed.
                    _state.update { it.copy(busy = false, formError = giveCreditErrorText(err)) }
                },
            )
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }
}

internal fun isPermissionDenied(err: Throwable): Boolean =
    (err as? FirebaseFunctionsException)?.code == FirebaseFunctionsException.Code.PERMISSION_DENIED

internal fun giveCreditErrorText(err: Throwable): String {
    val detail = err.message?.takeIf { it.isNotBlank() }
    return if (detail == null) "Couldn't give credit. Try again." else "Couldn't give credit: $detail"
}
