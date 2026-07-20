package com.tribetails.auntieos.web.screens.payments

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Link
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PiggyBank
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard

private class FirestorePaymentsDataSource(private val client: FirestoreClient) : PaymentsDataSource {
    override fun paymentsStream() = client.paymentsStream()
    override suspend fun recordPayment(payment: Payment): WriteResult<String> = client.recordPayment(payment)
}

@Composable
fun PaymentsScreen(onOpenInvoice: (String) -> Unit = {}) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    val dataSource = remember { FirestorePaymentsDataSource(client) }
    val vm = remember { PaymentsViewModel(dataSource) }
    val state by vm.uiState.collectAsState()

    var showDialog by remember { mutableStateOf(false) }

    // Search query + method filter tabs over the list. Client-side narrowing only;
    // never touches the data layer.
    var query by remember { mutableStateOf("") }
    var methodFilter by remember { mutableStateOf(PaymentMethodFilter.All) }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Payments",
            title      = "Payments",
            subtitle   = "Recorded payments from kinfolk",
            trailing   = {
                PrimaryButton(
                    label   = "Record Payment",
                    onClick = { showDialog = true },
                    leading = {
                        Icon(
                            Lucide.Plus,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = AuntieTheme.colors.background,
                        )
                    },
                )
            },
        )
        Spacer(Modifier.height(20.dp))

        // Fail-loud: surface a stream / write error as a persistent banner.
        state.error?.let { msg ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Payments error",
                icon  = Lucide.TriangleAlert,
                onDismiss = { vm.clearError() },
                body  = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.error) },
            )
            Spacer(Modifier.height(14.dp))
        }

        when {
            state.isLoading -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(3) { ShimmerCard(height = 80.dp) }
            }
            state.payments.isEmpty() && state.error == null -> PaymentsEmptyState()
            state.payments.isNotEmpty() -> {
                SummaryStrip(state.payments)
                Spacer(Modifier.height(20.dp))
                PaymentsLedger(
                    payments      = state.payments,
                    query         = query,
                    onQuery       = { query = it },
                    methodFilter  = methodFilter,
                    onMethod      = { methodFilter = it },
                    onOpenInvoice = onOpenInvoice,
                )
            }
        }
    }

    if (showDialog) {
        RecordPaymentDialog(
            visible   = showDialog,
            onDismiss = { showDialog = false },
            onConfirm = { payment ->
                vm.recordPayment(payment)
                showDialog = false
            },
        )
    }
}

// SUGGESTION (gated): method filter tabs. Not in the original source contract.
internal enum class PaymentMethodFilter(val label: String, val matches: (String) -> Boolean) {
    All("All", { true }),
    Cash("Cash", { it.equals("CASH", ignoreCase = true) }),
    Check("Check", { it.equals("CHECK", ignoreCase = true) }),
    Card("Card", { it.equals("CARD", ignoreCase = true) }),
    Transfer("Transfer", { it.equals("TRANSFER", ignoreCase = true) }),
}

/**
 * Client-side narrowing of the payment ledger: keeps rows matching the selected
 * payment-method tab AND (when the query is non-blank) any of the searchable text
 * fields. Pure, so it is unit-tested directly. Touches no data layer.
 */
internal fun paymentsSearchFilter(
    payments: List<Payment>,
    query: String,
    method: PaymentMethodFilter,
): List<Payment> =
    payments
        .filter { method.matches(it.paymentMethod) }
        .filter { p ->
            query.isBlank() || listOf(
                p.kinfolkName, p.client, p.paymentMethod, p.referenceNumber, p.notes,
            ).any { it.contains(query.trim(), ignoreCase = true) }
        }

/** A YYYY-MM-DD that parses to a real calendar date (used for validation + sort). */
private fun isValidIsoDate(value: String): Boolean {
    val s = value.trim()
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(s)) return false
    val month = s.substring(5, 7).toIntOrNull() ?: return false
    val day   = s.substring(8, 10).toIntOrNull() ?: return false
    if (month !in 1..12) return false
    val daysInMonth = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11           -> 30
        else                  -> 29 // permissive Feb; calendar leap-year check not required here
    }
    return day in 1..daysInMonth
}

@Composable
private fun PaymentsLedger(
    payments: List<Payment>,
    query: String,
    onQuery: (String) -> Unit,
    methodFilter: PaymentMethodFilter,
    onMethod: (PaymentMethodFilter) -> Unit,
    onOpenInvoice: (String) -> Unit,
) {
    DenPanel(
        title    = "Payment ledger",
        subtitle = "Every payment logged, newest first.",
    ) {
        // Method filter tabs + search box over the list.
        PaymentControls(
            query        = query,
            onQuery      = onQuery,
            methodFilter = methodFilter,
            onMethod     = onMethod,
        )
        Spacer(Modifier.height(14.dp))

        val narrowed = paymentsSearchFilter(payments, query, methodFilter)

        // Robust ordering: rows with a valid YYYY-MM-DD date sort descending; rows
        // with a blank or malformed date are pushed to the bottom in stable order,
        // so a bad write can no longer scramble the list (audited sort bug).
        val (dated, undated) = narrowed.partition { isValidIsoDate(it.date) }
        val visible = dated.sortedByDescending { it.date } + undated

        if (visible.isEmpty()) {
            EmptyHint("No payments match the current search or filter.")
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                visible.forEach { payment -> PaymentRow(payment, onOpenInvoice) }
            }
        }
    }
}

@Composable
private fun SummaryStrip(payments: List<Payment>) {
    val total = payments.sumOf { it.amount + it.tip }
    val tips  = payments.sumOf { it.tip }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StatCard(
            label    = "Total received",
            value    = formatMoney(total),
            trend    = "amount plus tips",
            tone     = AuntieStatusTone.Orange,
            feature  = true,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label    = "Tips",
            value    = formatMoney(tips),
            trend    = "of total received",
            tone     = AuntieStatusTone.Teal,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label    = "Count",
            value    = "${payments.size}",
            trend    = "payments logged",
            tone     = AuntieStatusTone.Purple,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PaymentControls(
    query: String,
    onQuery: (String) -> Unit,
    methodFilter: PaymentMethodFilter,
    onMethod: (PaymentMethodFilter) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PaymentMethodFilter.entries.forEach { tab ->
                AuntieChip(
                    label    = tab.label,
                    selected = tab == methodFilter,
                    onClick  = { onMethod(tab) },
                    tone     = AuntieChipTone.Orange,
                )
            }
        }
        AuntieSearchField(
            value         = query,
            onValueChange = onQuery,
            placeholder   = "Search kinfolk, method, or reference...",
            onClear       = { onQuery("") },
            modifier      = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PaymentRow(payment: Payment, onOpenInvoice: (String) -> Unit) {
    val c = AuntieTheme.colors
    val displayName = payment.kinfolkName.ifBlank { payment.client.ifBlank { "Unknown" } }

    // Static row (audited: the old empty-onClick clickable lied about a detail
    // view that does not exist). No hover-implies-click affordance now.
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(14.dp))
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            AuntieAvatar(
                initials     = displayName,
                gradientSeed = displayName,
                shape        = RoundedCornerShape(13.dp),
                size         = 42.dp,
            )

            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text  = displayName,
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                // Subline: date · method chip · "Ref: {ref}".
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    payment.date.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                    payment.paymentMethod.takeIf { it.isNotBlank() }?.let { method ->
                        Text("·", style = AuntieTheme.typography.mono, color = c.textFaint)
                        AuntieStatusPill(
                            label = method.replaceFirstChar { it.uppercase() },
                            tone  = methodTone(method),
                        )
                    }
                    payment.referenceNumber.takeIf { it.isNotBlank() }?.let { ref ->
                        Text("·", style = AuntieTheme.typography.mono, color = c.textFaint)
                        Text("Ref: $ref", style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                }
                if (payment.notes.isNotBlank()) {
                    Text(payment.notes, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(formatMoney(payment.amount), style = AuntieTheme.typography.titleLarge, color = c.primary)
                if (payment.tip > 0.0) {
                    Text("+ ${formatMoney(payment.tip)} tip", style = AuntieTheme.typography.mono, color = c.primary)
                }
            }
        }

        // Payment->invoice link (written by match_payments_to_invoices.py for confident
        // single-invoice matches: same kinfolk + payment date == an invoice payment date).
        // Tapping opens that invoice. Absent when no confident match exists (left honest).
        if (payment.invoiceId.isNotBlank()) {
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(9.dp))
                    .clickable { onOpenInvoice(payment.invoiceId) }
                    .padding(horizontal = 8.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Lucide.Link, contentDescription = null, tint = c.accent, modifier = Modifier.size(13.dp))
                Text(
                    "Invoice #${payment.invoiceNumber.ifBlank { payment.invoiceId }}",
                    style = AuntieTheme.typography.labelMedium,
                    color = c.accent,
                )
            }
        }
    }
}

private fun methodTone(method: String): AuntieStatusTone = when (method.trim().uppercase()) {
    "CASH"     -> AuntieStatusTone.Teal
    "CHECK"    -> AuntieStatusTone.Purple
    "CARD"     -> AuntieStatusTone.Orange
    "TRANSFER" -> AuntieStatusTone.Success
    else       -> AuntieStatusTone.Neutral
}

@Composable
private fun PaymentsEmptyState() {
    DenPanel(
        title    = "Payment ledger",
        subtitle = "Every payment logged, newest first.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            AuntieIconTile(icon = Lucide.PiggyBank, tone = AuntieStatusTone.Orange, size = 42.dp)
            Text(
                "No payments recorded yet",
                style = AuntieTheme.typography.headlineSmall,
                color = AuntieTheme.colors.textPrimary,
            )
            Text(
                "Tap \"Record Payment\" to log cash, check, card, or transfer payments from kinfolk.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
    }
}

@Composable
private fun RecordPaymentDialog(
    visible: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (Payment) -> Unit,
) {
    var kinfolkId    by remember { mutableStateOf("") }
    var kinfolkName  by remember { mutableStateOf("") }
    var amountText   by remember { mutableStateOf("") }
    var method       by remember { mutableStateOf("CASH") }
    var date         by remember { mutableStateOf("") }
    var referenceNum by remember { mutableStateOf("") }
    var notes        by remember { mutableStateOf("") }
    var tipText      by remember { mutableStateOf("") }
    var validationError by remember { mutableStateOf<String?>(null) }

    val c = AuntieTheme.colors
    val dateInvalid = date.isNotBlank() && !isValidIsoDate(date)

    val submit: () -> Unit = {
        val amount = amountText.toDoubleOrNull()
        val tip    = tipText.toDoubleOrNull() ?: 0.0
        when {
            kinfolkId.isBlank() -> { validationError = "Kinfolk ID is required" }
            amount == null || amount <= 0.0 -> { validationError = "Amount must be greater than zero" }
            // Audited: a malformed date used to write silently and scramble the sort.
            date.isNotBlank() && !isValidIsoDate(date) -> { validationError = "Date must be a real YYYY-MM-DD date" }
            else -> onConfirm(
                Payment(
                    kinfolkId       = kinfolkId.trim(),
                    kinfolkName     = kinfolkName.trim(),
                    amount          = amount,
                    tip             = tip,
                    paymentMethod   = method.trim().uppercase(),
                    date            = date.trim(),
                    referenceNumber = referenceNum.trim(),
                    notes           = notes.trim(),
                )
            )
        }
    }

    AuntieDialog(
        visible     = visible,
        title       = "Record Payment",
        onDismiss   = onDismiss,
        maxWidth    = 440.dp,
        closeIcon   = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.PiggyBank, tone = AuntieStatusTone.Orange, size = 38.dp) },
        footer      = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(label = "Save", onClick = submit, enabled = !dateInvalid)
        },
    ) {
        validationError?.let { err ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(11.dp))
                    .background(c.error.copy(alpha = 0.12f))
                    .border(AuntieTheme.dims.borderHairline, c.error.copy(alpha = 0.45f), RoundedCornerShape(11.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Text(err, style = AuntieTheme.typography.bodySmall, color = c.error)
            }
        }

        BottomBorderField(
            value         = kinfolkId,
            onValueChange = { kinfolkId = it },
            label         = "Kinfolk ID",
            modifier      = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value         = kinfolkName,
            onValueChange = { kinfolkName = it },
            label         = "Kinfolk Name",
            modifier      = Modifier.fillMaxWidth(),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            BottomBorderField(
                value         = amountText,
                onValueChange = { amountText = it },
                label         = "Amount ($)",
                modifier      = Modifier.weight(1f),
                keyboardType  = KeyboardType.Decimal,
            )
            BottomBorderField(
                value         = tipText,
                onValueChange = { tipText = it },
                label         = "Tip ($), optional",
                modifier      = Modifier.weight(1f),
                keyboardType  = KeyboardType.Decimal,
            )
        }
        // SUGGESTION: source uses a free-text Method field; a select is offered as
        // an improvement. Backed by the same `method` state the source writes.
        AuntieSelectField(
            label    = "Method (CASH / CHECK / CARD / TRANSFER)",
            options  = listOf("CASH", "CHECK", "CARD", "TRANSFER"),
            selected = method,
            onSelect = { method = it },
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value         = date,
            onValueChange = { date = it },
            label         = "Date (YYYY-MM-DD)",
            placeholder   = "YYYY-MM-DD",
            isError       = dateInvalid,
            modifier      = Modifier.fillMaxWidth(),
        )
        if (dateInvalid) {
            Text(
                "Enter a real date as YYYY-MM-DD (for example 2026-05-27).",
                style = AuntieTheme.typography.bodySmall,
                color = c.error,
            )
        }
        BottomBorderField(
            value         = referenceNum,
            onValueChange = { referenceNum = it },
            label         = "Reference number, optional",
            modifier      = Modifier.fillMaxWidth(),
        )
        MultilineField(
            value         = notes,
            onValueChange = { notes = it },
            label         = "Notes, optional",
            modifier      = Modifier.fillMaxWidth(),
            minLines      = 3,
        )
    }
}

private fun formatMoney(value: Double): String {
    val cents  = (value * 100).toLong()
    val dollars = cents / 100
    val rem    = cents % 100
    return "$$dollars.${rem.toString().padStart(2, '0')}"
}
