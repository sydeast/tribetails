package com.tribetails.auntieos.ui.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.domain.applyCreditConfirmText
import com.tribetails.auntieos.domain.availableCreditLine
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #1872: the Account credit box on an invoice that can take a payment. The
 * household's available credit, an amount she types, and Apply credit. The
 * refusal sits directly under the field. Nothing here moves money until she
 * agrees in [ApplyCreditConfirmDialog].
 */
@Composable
internal fun InvoiceApplyCreditPanel(
    state: ApplyCreditUiState,
    onAmount: (String) -> Unit,
    onReview: () -> Unit,
    onRetryLoad: () -> Unit,
) {
    if (!state.visible) return
    val c = AuntieTheme.colors
    val available = state.availableCents
    DenPanel(
        title = "Account credit",
        detail = available?.let { availableCreditLine(it) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                available == null && state.loadError != null -> {
                    EmptyHint(state.loadError, error = true)
                    GhostButton(label = "Try again", onClick = onRetryLoad)
                }
                available == null -> EmptyHint("Loading account credit...")
                available <= 0L -> Unit
                else -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        AuntieField(
                            value = state.amountText,
                            onValueChange = onAmount,
                            label = "Amount to apply",
                            placeholder = "25.00",
                            modifier = Modifier.weight(1f),
                            enabled = !state.busy,
                            isError = state.fieldError != null,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        )
                        GhostButton(label = "Apply credit", onClick = onReview, enabled = !state.busy)
                    }
                    state.fieldError?.let {
                        Text(it, style = AuntieTheme.typography.bodySmall, color = c.error)
                    }
                }
            }
        }
    }
}

/** The confirmation: the amount and the invoice by name, then the one call, with a visible wait. */
@Composable
internal fun ApplyCreditConfirmDialog(
    state: ApplyCreditUiState,
    invoiceNumber: String?,
    dueCents: Long?,
    onBack: () -> Unit,
    onConfirm: () -> Unit,
) {
    AuntieDialog(
        visible = state.step == ApplyCreditStep.Confirm,
        title = "Apply account credit?",
        // The controller refuses to go back while the call is in flight.
        onDismiss = onBack,
        maxWidth = 480.dp,
        footer = {
            GhostButton(label = "Back", onClick = onBack, enabled = !state.busy)
            PrimaryButton(
                label = if (state.busy) "Applying credit…" else "Apply credit",
                onClick = onConfirm,
                enabled = !state.busy,
                loading = state.busy,
            )
        },
    ) {
        Text(
            applyCreditConfirmText(
                amountCents = state.pendingAmountCents,
                invoiceNumber = invoiceNumber,
                availableCents = state.availableCents ?: 0L,
                dueCents = dueCents,
            ),
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textPrimary,
        )
    }
}
