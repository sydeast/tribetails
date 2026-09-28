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
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultCredit
import com.tribetails.auntieos.domain.MAX_CREDIT_REASON_LENGTH
import com.tribetails.auntieos.domain.accountBalanceLine
import com.tribetails.auntieos.domain.creditApplicationLines
import com.tribetails.auntieos.domain.creditGivenLine
import com.tribetails.auntieos.domain.creditStatusLine
import com.tribetails.auntieos.domain.creditUseLine
import com.tribetails.auntieos.domain.formatCentsUsd
import com.tribetails.auntieos.domain.giveCreditConfirmText
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Q6: the household's account credit. The balance, Give credit, the credits
 * given (amount, date, reason, date applied) and every use of credit.
 */
@Composable
internal fun AccountCreditPanel(
    state: AccountCreditUiState,
    onGiveCredit: () -> Unit,
    /** #1003: the "Payments needing a decision" sub-section, under the history. */
    below: @Composable () -> Unit = {},
) {
    DenPanel(
        title = "Account credit",
        trailing = { GhostButton(label = "Give credit", onClick = onGiveCredit, enabled = !state.busy) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AccountCreditHistoryBody(state)
            below()
        }
    }
}

@Composable
private fun AccountCreditHistoryBody(state: AccountCreditUiState) {
    val c = AuntieTheme.colors
    val history = state.history
    run {
        when {
            history == null && state.loadError != null -> EmptyHint(state.loadError, error = true)
            history == null -> EmptyHint("Loading account credit...")
            else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    accountBalanceLine(history.accountBalanceCents),
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                if (history.credits.isEmpty()) {
                    EmptyHint("No credit given yet.")
                } else {
                    Text("Credits given", style = AuntieTheme.typography.labelLarge, color = c.textDim)
                    history.credits.forEachIndexed { i, credit ->
                        CreditRow(credit, last = i == history.credits.lastIndex)
                    }
                }
                if (history.uses.isNotEmpty()) {
                    Text("Credit used", style = AuntieTheme.typography.labelLarge, color = c.textDim)
                    history.uses.forEach { use ->
                        Text(creditUseLine(use), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                    }
                }
            }
        }
    }
}

@Composable
private fun CreditRow(credit: GetAccountCreditHistoryResultCredit, last: Boolean) {
    val c = AuntieTheme.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(formatCentsUsd(credit.amountCents), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            Text(creditGivenLine(credit), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        Text(credit.reason, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
        Text(creditStatusLine(credit), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        creditApplicationLines(credit).forEach { line ->
            Text(line, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        }
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderSoft))
}

/** The Give credit dialog: the fields, then a confirmation with the new balance. */
@Composable
internal fun GiveCreditDialog(
    state: AccountCreditUiState,
    onAmount: (String) -> Unit,
    onReason: (String) -> Unit,
    onReview: () -> Unit,
    onBack: () -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    AuntieDialog(
        visible = state.step != GiveCreditStep.Closed,
        title = "Give credit",
        // The controller refuses a dismissal while a save is in flight.
        onDismiss = onDismiss,
        maxWidth = 480.dp,
        footer = {
            if (state.step == GiveCreditStep.Confirm) {
                GhostButton(label = "Back", onClick = onBack, enabled = !state.busy)
                PrimaryButton(label = "Give credit", onClick = onConfirm, enabled = !state.busy, loading = state.busy)
            } else {
                GhostButton(label = "Cancel", onClick = onDismiss)
                PrimaryButton(label = "Review", onClick = onReview)
            }
        },
    ) {
        if (state.step == GiveCreditStep.Confirm) {
            Text(
                giveCreditConfirmText(state.pendingAmountCents, state.history?.accountBalanceCents),
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
            Text(state.pendingReason, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        } else {
            AuntieField(
                value = state.amountText,
                onValueChange = onAmount,
                label = "Amount",
                placeholder = "25.00",
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            AuntieField(
                value = state.reasonText,
                onValueChange = { if (it.length <= MAX_CREDIT_REASON_LENGTH) onReason(it) },
                label = "Reason",
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )
        }
        state.formError?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
    }
}
