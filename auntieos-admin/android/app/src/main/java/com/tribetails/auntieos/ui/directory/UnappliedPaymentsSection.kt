package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultPayment
import com.tribetails.auntieos.domain.DECIDE_NONE_OPTION
import com.tribetails.auntieos.domain.DecideForm
import com.tribetails.auntieos.domain.MAX_CREDIT_REASON_LENGTH
import com.tribetails.auntieos.domain.NO_OPEN_INVOICES_TEXT
import com.tribetails.auntieos.domain.decidePaymentLead
import com.tribetails.auntieos.domain.decideSummaryLine
import com.tribetails.auntieos.domain.openInvoiceOptionLabel
import com.tribetails.auntieos.domain.unappliedPaymentDetail
import com.tribetails.auntieos.domain.unappliedPaymentHeadline
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieSelectField
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #1003: "Payments needing a decision", inside the Account credit panel. One
 * row per card payment the webhook recorded but did not apply, each with a
 * Decide button. Hidden when there are none, unless the notice opened this
 * profile; hidden silently on permission-denied.
 */
@Composable
internal fun UnappliedPaymentsSubsection(
    state: UnappliedPaymentsUiState,
    onDecide: (paymentId: String) -> Unit,
    onRetry: () -> Unit,
) {
    if (!state.showSection) return
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderSoft))
        Text("Payments needing a decision", style = AuntieTheme.typography.labelLarge, color = c.textDim)
        when {
            state.result == null && state.loadError != null -> {
                EmptyHint(state.loadError, error = true)
                GhostButton(label = "Retry", onClick = onRetry, enabled = !state.loading)
            }
            state.payments.isEmpty() -> if (state.result != null) EmptyHint(UNAPPLIED_EMPTY_FROM_NOTICE)
            else -> state.payments.forEach { p ->
                UnappliedPaymentRow(p, enabled = !state.busy, onDecide = { onDecide(p.paymentId) })
            }
        }
    }
}

@Composable
private fun UnappliedPaymentRow(p: ListUnappliedPaymentsResultPayment, enabled: Boolean, onDecide: () -> Unit) {
    val c = AuntieTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(unappliedPaymentHeadline(p), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            Text(unappliedPaymentDetail(p), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        GhostButton(label = "Decide", onClick = onDecide, enabled = enabled)
    }
}

/**
 * The Decide dialog. Every value it sends is read from its own four inputs
 * (credit, reason, invoice, amount to apply); it never rebuilds or writes back
 * the payment or the invoice.
 */
@Composable
internal fun DecidePaymentDialog(
    state: UnappliedPaymentsUiState,
    onCredit: (String) -> Unit,
    onReason: (String) -> Unit,
    onApplyInvoice: (String) -> Unit,
    onApply: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val payment = state.dialogPayment
    val c = AuntieTheme.colors
    val form = state.form
    val openInvoices = state.result?.openInvoices.orEmpty()
    AuntieDialog(
        visible = payment != null,
        title = "Decide what this payment becomes",
        // The controller refuses a dismissal while a save is in flight.
        onDismiss = onDismiss,
        maxWidth = 520.dp,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = !state.busy)
            PrimaryButton(
                label = if (state.busy) "Saving..." else "Save decision",
                onClick = onSave,
                enabled = !state.busy && form is DecideForm.Ready,
            )
        },
    ) {
        if (payment == null) return@AuntieDialog
        Text(decidePaymentLead(payment), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        AuntieField(
            value = state.creditText,
            onValueChange = onCredit,
            label = "Account credit ($)",
            placeholder = "0.00",
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        )
        AuntieField(
            value = state.reasonText,
            onValueChange = { if (it.length <= MAX_CREDIT_REASON_LENGTH) onReason(it) },
            label = "Reason for the credit",
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            minLines = 2,
        )
        if (openInvoices.isEmpty()) {
            Text(NO_OPEN_INVOICES_TEXT, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        } else {
            val options = listOf("") + openInvoices.map { it.invoiceId }
            AuntieSelectField(
                label = "Apply to invoice",
                options = options,
                selected = state.applyInvoiceId.takeIf { it in options } ?: "",
                onSelect = onApplyInvoice,
                optionLabel = { id ->
                    if (id.isEmpty()) DECIDE_NONE_OPTION
                    else openInvoices.firstOrNull { it.invoiceId == id }?.let(::openInvoiceOptionLabel) ?: id
                },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = state.applyText,
                onValueChange = onApply,
                label = "Amount to apply ($)",
                placeholder = "0.00",
                enabled = !state.busy && state.applyInvoiceId.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
        }
        when (form) {
            is DecideForm.Ready ->
                Text(decideSummaryLine(form), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            is DecideForm.Invalid ->
                Text(form.message, style = AuntieTheme.typography.bodySmall, color = c.error)
            null -> Unit
        }
        state.saveError?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
    }
}
