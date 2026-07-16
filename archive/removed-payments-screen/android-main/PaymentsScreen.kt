package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.admin.AuditLog
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PaymentsScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit
) {
    val c = AuntieTheme.colors
    val payments by viewModel.payments.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    var searchQuery by remember { mutableStateOf("") }
    var methodFilter by remember { mutableStateOf(PaymentMethodFilter.All) }
    var showAddDialog by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.loadPayments()
    }

    AuntieScreenScaffold(
        title = "Payments",
        onBack = onBack,
        actions = {
            AuntieIconBtn(onClick = { showAddDialog = true }) {
                Icon(Lucide.Plus, contentDescription = "Add Payment")
            }
        },
    ) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh = { viewModel.loadPayments() },
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(vertical = 16.dp),
            ) {
                item {
                    DenScreenHeading(
                        kicker = "The Den · Payments",
                        title = "Payments",
                        subtitle = "Recorded payments from kinfolk",
                    )
                }

                // Fail-loud: surface a stream / write error as a persistent banner.
                error?.let { msg ->
                    item {
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            title = "Payments error",
                            icon = Lucide.TriangleAlert,
                            onDismiss = { viewModel.clearError() },
                            body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.error) },
                        )
                    }
                }

                if (payments.isEmpty() && error == null) {
                    item { PaymentsEmptyState() }
                } else if (payments.isNotEmpty()) {
                    item { SummaryStrip(payments) }
                    item {
                        PaymentsLedger(
                            payments = payments,
                            query = searchQuery,
                            onQuery = { searchQuery = it },
                            methodFilter = methodFilter,
                            onMethod = { methodFilter = it },
                        )
                    }
                }
            }
        }

        if (showAddDialog) {
            AddPaymentDialog(
                onDismiss = { showAddDialog = false },
                onSave = { payment ->
                    viewModel.createPayment(payment)
                    AuditLog.fire(
                        scope = scope,
                        repository = AuntieOSApp.instance.repository,
                        actionType = "PAYMENT_CREATED",
                        description = "Recorded $${payment.amount} payment from ${payment.client}",
                        targetCollection = "payments",
                    )
                    showAddDialog = false
                },
            )
        }
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
 * fields. Pure, so it is unit-tested directly. Touches no data layer. Mirrors the
 * web `paymentsSearchFilter` name + behavior byte-for-byte.
 */
/**
 * The per-row invoice reference for a payment, or null when unlinked. Payment now
 * carries invoiceId + invoiceNumber (parity with web), so the row resolves a link
 * without a separate invoices join. Replaces the retired FF_PAYMENTS_INVOICE_LINK.
 */
internal fun paymentInvoiceLabel(payment: Payment): String? {
    val num = payment.invoiceNumber.trim()
    val id = payment.invoiceId.trim()
    return when {
        num.isNotBlank() -> num
        id.isNotBlank() -> id.take(8)
        else -> null
    }
}

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

/** A YYYY-MM-DD that parses to a real calendar date (used for sort ordering). */
private fun isValidIsoDate(value: String): Boolean {
    val s = value.trim()
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(s)) return false
    val month = s.substring(5, 7).toIntOrNull() ?: return false
    val day = s.substring(8, 10).toIntOrNull() ?: return false
    if (month !in 1..12) return false
    val daysInMonth = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        else -> 29 // permissive Feb; calendar leap-year check not required here
    }
    return day in 1..daysInMonth
}

@Composable
private fun SummaryStrip(payments: List<Payment>) {
    val total = payments.sumOf { it.amount + it.tip }
    val tips = payments.sumOf { it.tip }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StatCard(
            label = "Total received",
            value = formatMoney(total),
            trend = "amount plus tips",
            tone = AuntieStatusTone.Orange,
            feature = true,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "Tips",
            value = formatMoney(tips),
            trend = "of total received",
            tone = AuntieStatusTone.Teal,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "Count",
            value = "${payments.size}",
            trend = "payments logged",
            tone = AuntieStatusTone.Purple,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PaymentsLedger(
    payments: List<Payment>,
    query: String,
    onQuery: (String) -> Unit,
    methodFilter: PaymentMethodFilter,
    onMethod: (PaymentMethodFilter) -> Unit,
) {
    DenPanel(
        title = "Payment ledger",
        subtitle = "Every payment logged, newest first.",
    ) {
        // Method filter tabs + search box over the loaded list (always on).
        PaymentControls(
            query = query,
            onQuery = onQuery,
            methodFilter = methodFilter,
            onMethod = onMethod,
        )
        Spacer(Modifier.height(14.dp))

        // The per-row invoice link below reads payment.invoiceId/invoiceNumber
        // directly (parity with web); the old FF_PAYMENTS_INVOICE_LINK dark gate
        // is retired now that both fields exist on the Payment model.

        // Narrow the loaded ledger by the active method tab + search query.
        val narrowed = paymentsSearchFilter(payments, query, methodFilter)

        // Robust ordering: rows with a valid YYYY-MM-DD date sort descending; rows
        // with a blank or malformed date are pushed to the bottom in stable order.
        val (dated, undated) = narrowed.partition { isValidIsoDate(it.date) }
        val visible = dated.sortedByDescending { it.date } + undated

        if (visible.isEmpty()) {
            EmptyHint("No payments match the current search or filter.")
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                visible.forEach { payment -> PaymentRow(payment) }
            }
        }
    }
}

// Search + method-filter strip over the loaded payment ledger.
@Composable
private fun PaymentControls(
    query: String,
    onQuery: (String) -> Unit,
    methodFilter: PaymentMethodFilter,
    onMethod: (PaymentMethodFilter) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PaymentMethodFilter.entries.forEach { tab ->
                AuntieChip(
                    label = tab.label,
                    selected = tab == methodFilter,
                    onClick = { onMethod(tab) },
                )
            }
        }
        AuntieSearchField(
            value = query,
            onValueChange = onQuery,
            placeholder = "Search kinfolk, method, or reference...",
            onClear = { onQuery("") },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// Mirrors the web PaymentRow: a glass card with avatar + name + a date/method/ref
// subline and an amount on the right. AuntieEntityRow has no rich-content slot for
// the pill subline, so this stays a custom Den row (matching the web design source)
// built from the same listed primitives (AuntieAvatar, AuntieStatusPill, theme).
@Composable
private fun PaymentRow(payment: Payment) {
    val c = AuntieTheme.colors
    val displayName = payment.kinfolkName.ifBlank { payment.client.ifBlank { "Unknown" } }

    // Static row (no onClick): no detail view exists, so no click affordance.
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
                initials = displayName,
                gradientSeed = displayName,
                shape = RoundedCornerShape(13.dp),
                size = 42.dp,
            )

            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text = displayName,
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                // Subline: date · method pill · "Ref: {ref}".
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
                            tone = methodTone(method),
                        )
                    }
                    payment.referenceNumber.takeIf { it.isNotBlank() }?.let { ref ->
                        Text("·", style = AuntieTheme.typography.mono, color = c.textFaint)
                        Text("Ref: $ref", style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                    paymentInvoiceLabel(payment)?.let { inv ->
                        Text("·", style = AuntieTheme.typography.mono, color = c.textFaint)
                        Text("Invoice $inv", style = AuntieTheme.typography.mono, color = c.textDim)
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
    }
}

private fun methodTone(method: String): AuntieStatusTone = when (method.trim().uppercase()) {
    "CASH" -> AuntieStatusTone.Teal
    "CHECK" -> AuntieStatusTone.Purple
    "CARD" -> AuntieStatusTone.Orange
    "TRANSFER" -> AuntieStatusTone.Success
    else -> AuntieStatusTone.Neutral
}

@Composable
private fun PaymentsEmptyState() {
    DenPanel(
        title = "Payment ledger",
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

/**
 * Manual payment entry. Used for cash/check payments that don't flow through
 * an integrated processor. Validation: client + amount required. Audit fires
 * after the dialog dismisses (success path); failures surface through the
 * AdminDataViewModel._error flow per [[fail-loud-policy]].
 *
 * Defaults date to today (ISO YYYY-MM-DD) so the operator usually doesn't
 * have to type it. Date is editable for back-dated entries.
 */
@Composable
private fun AddPaymentDialog(
    onDismiss: () -> Unit,
    onSave: (Payment) -> Unit,
) {
    var client by remember { mutableStateOf("") }
    var kinfolkName by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var tip by remember { mutableStateOf("0") }
    var paymentMethod by remember { mutableStateOf("") }
    var referenceNumber by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(java.time.LocalDate.now().toString()) }

    Dialog(
        onDismissRequest = onDismiss,
        properties       = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        AuntieCard(
            modifier       = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.9f),
            containerColor = AuntieTheme.colors.background,
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Text(
                        text       = "Record Payment",
                        style      = AuntieTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color      = AuntieTheme.colors.textPrimary,
                    )
                    AuntieIconBtn(onClick = onDismiss) {
                        Icon(Lucide.X, contentDescription = "Close")
                    }
                }

                Box(
                    modifier = Modifier
                        .padding(vertical = 8.dp)
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(AuntieTheme.colors.border),
                )

                Column(
                    modifier            = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    AuntieField(
                        value         = client,
                        onValueChange = { client = it },
                        label         = "Client *",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    AuntieField(
                        value         = kinfolkName,
                        onValueChange = { kinfolkName = it },
                        label         = "Kinfolk Name (optional)",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AuntieField(
                            value         = amount,
                            onValueChange = { amount = it },
                            label         = "Amount ($) *",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            leading       = { Icon(Lucide.DollarSign, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange) },
                            modifier      = Modifier.weight(1f),
                        )
                        AuntieField(
                            value         = tip,
                            onValueChange = { tip = it },
                            label         = "Tip ($)",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier      = Modifier.weight(1f),
                        )
                    }
                    AuntieField(
                        value         = paymentMethod,
                        onValueChange = { paymentMethod = it },
                        label         = "Payment Method",
                        placeholder   = "Cash, Check, Venmo, Zelle, …",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    AuntieField(
                        value         = referenceNumber,
                        onValueChange = { referenceNumber = it },
                        label         = "Reference Number",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    AuntieField(
                        value         = email,
                        onValueChange = { email = it },
                        label         = "Email (optional)",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    AuntieField(
                        value         = date,
                        onValueChange = { date = it },
                        label         = "Date (YYYY-MM-DD)",
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    AuntieField(
                        value         = notes,
                        onValueChange = { notes = it },
                        label         = "Notes",
                        singleLine    = false,
                        minLines      = 2,
                        maxLines      = 4,
                        modifier      = Modifier.fillMaxWidth(),
                    )
                }

                Box(
                    modifier = Modifier
                        .padding(vertical = 8.dp)
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(AuntieTheme.colors.border),
                )

                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label   = "Save Payment",
                        onClick = {
                            onSave(
                                Payment(
                                    kinfolkName     = kinfolkName.trim(),
                                    client          = client.trim(),
                                    date            = date.trim(),
                                    paymentMethod   = paymentMethod.trim(),
                                    referenceNumber = referenceNumber.trim(),
                                    email           = email.trim(),
                                    tip             = tip.toDoubleOrNull() ?: 0.0,
                                    amount          = amount.toDoubleOrNull() ?: 0.0,
                                    notes           = notes.trim(),
                                ),
                            )
                        },
                        enabled  = client.isNotBlank() && (amount.toDoubleOrNull() ?: 0.0) > 0.0,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

private fun formatMoney(value: Double): String {
    val cents = (value * 100).toLong()
    val dollars = cents / 100
    val rem = cents % 100
    return "$$dollars.${rem.toString().padStart(2, '0')}"
}
