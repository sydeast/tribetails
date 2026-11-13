package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.ApplyCreditEntry
import com.tribetails.auntieos.web.data.ApplyCreditOutcome
import com.tribetails.auntieos.web.data.ApplyCreditSubmissionKeys
import com.tribetails.auntieos.web.data.CreditHistoryLoad
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.loadAccountCreditHistory
import com.tribetails.auntieos.web.data.submitApplyCredit
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.util.formatUsdCents
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull

/*
 * #1872 (operator ruling 2026-11-11): ACCOUNT CREDIT IS NEVER SPENT
 * AUTOMATICALLY. It goes onto an invoice only here, as an amount the admin
 * types: the household's available credit, an amount field, a confirmation that
 * names the amount and the invoice, and then the one call. The words match the
 * web and Android admin clients. The server makes every check again.
 */

// ---- Pure text helpers (commonTest covers every one) ----

/** What the amount field came to. */
sealed class ApplyCreditForm {
    data class Ready(val amountCents: Long) : ApplyCreditForm()
    data class Invalid(val message: String) : ApplyCreditForm()
}

/**
 * Reads the amount field against what the household holds and what the invoice
 * owes. [dueCents] is null when the balance could not be read; the server then
 * decides that limit.
 */
fun parseApplyCreditAmount(amountText: String, availableCents: Long, dueCents: Long?): ApplyCreditForm {
    val cents = parseDollarsToCents(amountText)
        ?: return ApplyCreditForm.Invalid("Enter an amount in dollars, like 25.00.")
    if (cents <= 0L) return ApplyCreditForm.Invalid("Enter an amount above $0.00.")
    if (cents > availableCents) {
        return ApplyCreditForm.Invalid(
            "This household has ${formatUsdCents(availableCents)} of account credit. Enter that much or less.",
        )
    }
    if (dueCents != null && cents > dueCents) {
        return ApplyCreditForm.Invalid(
            "This invoice has ${formatUsdCents(dueCents)} left to pay. Enter that much or less.",
        )
    }
    return ApplyCreditForm.Ready(cents)
}

/** "invoice 1026", or "this invoice" when it has no number. Never a stored id. */
fun applyCreditInvoiceWords(invoiceNumber: String?): String {
    val n = invoiceNumber.orEmpty().trim()
    return if (n.isEmpty()) "this invoice" else "invoice $n"
}

/** The confirmation: the amount, the invoice, and what both balances become. */
fun applyCreditConfirmText(amountCents: Long, invoiceNumber: String?, availableCents: Long, dueCents: Long?): String {
    val lead = "Apply ${formatUsdCents(amountCents)} of account credit to ${applyCreditInvoiceWords(invoiceNumber)}?"
    val credit = "The household keeps ${formatUsdCents(availableCents - amountCents)} of credit."
    if (dueCents == null) return "$lead $credit"
    val left = dueCents - amountCents
    val invoice = if (left == 0L) "The invoice will be paid." else "The invoice will have ${formatUsdCents(left)} left to pay."
    return "$lead $invoice $credit"
}

/** After the save, from the server's own figures only. */
fun applyCreditDoneText(outcome: ApplyCreditOutcome, invoiceNumber: String?): String {
    val lead = "Applied ${formatUsdCents(outcome.appliedCents)} of account credit to ${applyCreditInvoiceWords(invoiceNumber)}."
    val invoice =
        if (outcome.amountDueCents == 0L) "The invoice is paid." else "${formatUsdCents(outcome.amountDueCents)} is left to pay."
    return "$lead $invoice The household has ${formatUsdCents(outcome.accountBalanceCents)} of credit left."
}

/** The line beside the title: what the household holds. */
fun applyCreditAvailableText(availableCents: Long): String =
    if (availableCents > 0L) "${formatUsdCents(availableCents)} available" else "This household has no account credit."

/** Archived iff `archivedAt` is stored and not null, the server's own rule (`lib/invoiceArchive.ts`). */
fun invoiceIsArchived(invoice: Invoice): Boolean = invoice.archivedAt != null && invoice.archivedAt !is JsonNull

/**
 * Whether the invoice detail offers the Account credit block. Where Record
 * payment is offered (the same stored-state answer), so a draft, a quote and a
 * paid invoice never show it, and never on an archived invoice or one with no
 * household.
 */
fun offersApplyCredit(invoice: Invoice, actions: List<InvoiceAction>): Boolean =
    InvoiceAction.RECORD_PAYMENT in actions && !invoiceIsArchived(invoice) && invoice.kinfolkId.isNotBlank()

// ---- State, outside Compose so jvmTest drives it ----

/** What the household's balance read came to. */
sealed class ApplyCreditBalance {
    object Loading : ApplyCreditBalance()
    data class Ready(val availableCents: Long) : ApplyCreditBalance()

    /** The server will not show this account money: the block is not drawn. */
    object Hidden : ApplyCreditBalance()
    data class Failed(val message: String) : ApplyCreditBalance()
}

enum class ApplyCreditStep { Form, Confirm }

data class ApplyCreditUiState(
    val balance: ApplyCreditBalance = ApplyCreditBalance.Loading,
    val amountText: String = "",
    val step: ApplyCreditStep = ApplyCreditStep.Form,
    /** The parsed amount on the Confirm step. */
    val pendingAmountCents: Long = 0L,
    /** A refusal from the field checks or from the server, shown under the field. */
    val fieldError: String? = null,
    val busy: Boolean = false,
)

/**
 * The Account credit block's behaviour for one invoice.
 *
 * ONE KEY PER SUBMISSION ([ApplyCreditSubmissionKeys]): kept across a failed
 * attempt so pressing Apply credit again lands on the same payment, new when
 * the amount changes, released on success.
 *
 * Builds a request only. No stored model is rebuilt from form state.
 */
class ApplyCreditController(
    private val client: FirestoreClient,
    private val invoiceId: String,
    private val kinfolkId: String,
    private val keys: ApplyCreditSubmissionKeys = ApplyCreditSubmissionKeys(),
) {
    private val _state = MutableStateFlow(ApplyCreditUiState())
    val state: StateFlow<ApplyCreditUiState> = _state.asStateFlow()

    /** Reads the household's balance. A refusal hides the block. */
    suspend fun load() {
        val balance = when (val r = loadAccountCreditHistory(client, kinfolkId)) {
            is CreditHistoryLoad.Loaded -> ApplyCreditBalance.Ready(maxOf(0L, r.history.accountBalanceCents))
            CreditHistoryLoad.Hidden -> ApplyCreditBalance.Hidden
            is CreditHistoryLoad.Failed -> ApplyCreditBalance.Failed(r.message)
        }
        _state.update { it.copy(balance = balance) }
    }

    /**
     * Reads the balance again after an attempt. A re-read that fails must not
     * replace a balance she could still act on.
     */
    private suspend fun reloadKeepingKnownBalance() {
        val before = _state.value.balance
        load()
        if (_state.value.balance is ApplyCreditBalance.Failed && before is ApplyCreditBalance.Ready) {
            _state.update { it.copy(balance = before) }
        }
    }

    fun setAmount(text: String) {
        if (_state.value.busy) return
        _state.update { it.copy(amountText = text, fieldError = null) }
    }

    /** Apply credit on the form: check the amount, then show the confirmation. */
    fun review(dueCents: Long?) {
        val s = _state.value
        val ready = s.balance as? ApplyCreditBalance.Ready ?: return
        if (s.busy) return
        when (val form = parseApplyCreditAmount(s.amountText, ready.availableCents, dueCents)) {
            is ApplyCreditForm.Invalid -> _state.update { it.copy(fieldError = form.message) }
            is ApplyCreditForm.Ready -> _state.update {
                it.copy(step = ApplyCreditStep.Confirm, pendingAmountCents = form.amountCents, fieldError = null)
            }
        }
    }

    /** Back from the confirmation to the field. Nothing changed, so the key stays. */
    fun back() {
        if (_state.value.busy) return
        _state.update { it.copy(step = ApplyCreditStep.Form) }
    }

    /**
     * Apply credit on the confirmation. Returns the server's answer once credit
     * has moved, or null when nothing was sent or the server refused (its words
     * are then under the field and the form is back). A press while a call is
     * in flight does nothing.
     */
    suspend fun confirm(): ApplyCreditOutcome? {
        val s = _state.value
        if (s.busy || s.step != ApplyCreditStep.Confirm) return null
        _state.update { it.copy(busy = true, fieldError = null) }
        val entry = ApplyCreditEntry(invoiceId = invoiceId, amountCents = s.pendingAmountCents)
        return when (val r = submitApplyCredit(client, entry, keys)) {
            is WriteResult.Ok -> {
                _state.update {
                    it.copy(
                        busy = false,
                        step = ApplyCreditStep.Form,
                        amountText = "",
                        pendingAmountCents = 0L,
                        balance = ApplyCreditBalance.Ready(maxOf(0L, r.value.accountBalanceCents)),
                    )
                }
                // The household's balance, read again from the server.
                reloadKeepingKnownBalance()
                r.value
            }
            is WriteResult.Err -> {
                // The server's refusal is already in plain words; it goes under
                // the field, and the form comes back so she can change the amount.
                _state.update { it.copy(busy = false, step = ApplyCreditStep.Form, fieldError = r.message) }
                // What she holds or owes may have moved under her: read it again.
                reloadKeepingKnownBalance()
                null
            }
        }
    }
}

// ---- Composable ----

/**
 * The Account credit block on the invoice detail. Drawn only where
 * [offersApplyCredit] says so. [onApplied] gets the sentence that says what
 * happened, for the screen's toast.
 */
@Composable
internal fun InvoiceApplyCreditPanel(
    invoice: Invoice,
    client: FirestoreClient,
    onApplied: (String) -> Unit,
) {
    val controller = remember(invoice._id, invoice.kinfolkId) {
        ApplyCreditController(client, invoice._id, invoice.kinfolkId)
    }
    val state by controller.state.collectAsState()
    val scope = rememberReportingScope()
    LaunchedEffect(controller) { controller.load() }

    ApplyCreditBlock(
        state = state,
        invoiceNumber = invoice.invoiceNumber,
        dueCents = invoiceBalanceCents(invoice),
        onAmount = controller::setAmount,
        onReview = { controller.review(invoiceBalanceCents(invoice)) },
        onBack = controller::back,
        onConfirm = {
            scope.launch {
                controller.confirm()?.let { onApplied(applyCreditDoneText(it, invoice.invoiceNumber)) }
            }
        },
        onRetry = { scope.launch { controller.load() } },
    )
}

/** The block's drawing, state in and events out, so jvmTest can render it. */
@Composable
internal fun ApplyCreditBlock(
    state: ApplyCreditUiState,
    invoiceNumber: String?,
    dueCents: Long?,
    onAmount: (String) -> Unit,
    onReview: () -> Unit,
    onBack: () -> Unit,
    onConfirm: () -> Unit,
    onRetry: () -> Unit,
) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val balance = state.balance
    if (balance == ApplyCreditBalance.Hidden) return
    DenPanel(
        title = "Account credit",
        detail = (balance as? ApplyCreditBalance.Ready)?.let { applyCreditAvailableText(it.availableCents) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (balance) {
                ApplyCreditBalance.Hidden -> Unit
                ApplyCreditBalance.Loading -> ShimmerCard(height = 40.dp)
                is ApplyCreditBalance.Failed -> {
                    Text("Couldn't load account credit: ${balance.message}", style = t.bodySmall, color = c.error)
                    GhostButton(label = "Try again", onClick = onRetry)
                }
                is ApplyCreditBalance.Ready -> when {
                    state.step == ApplyCreditStep.Confirm -> {
                        Text(
                            applyCreditConfirmText(state.pendingAmountCents, invoiceNumber, balance.availableCents, dueCents),
                            style = t.bodyMedium,
                            color = c.textPrimary,
                        )
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            GhostButton(label = "Back", onClick = onBack, enabled = !state.busy)
                            Spacer(Modifier.width(8.dp))
                            PrimaryButton(
                                label = if (state.busy) "Applying credit…" else "Apply credit",
                                enabled = !state.busy,
                                loading = state.busy,
                                onClick = onConfirm,
                            )
                        }
                    }
                    balance.availableCents > 0L -> {
                        Row(
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            // The refusal is the field's own error line, directly under it.
                            BottomBorderField(
                                state.amountText, onAmount,
                                label = "Amount to apply",
                                placeholder = "25.00",
                                keyboardType = KeyboardType.Decimal,
                                isError = state.fieldError != null,
                                errorMessage = state.fieldError,
                                modifier = Modifier.widthIn(max = 320.dp).weight(1f, fill = false),
                            )
                            GhostButton(label = "Apply credit", onClick = onReview)
                        }
                    }
                    else -> Unit
                }
            }
        }
    }
}
