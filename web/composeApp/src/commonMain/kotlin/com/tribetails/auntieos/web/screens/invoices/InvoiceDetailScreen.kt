package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Link
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageSquare
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.ReceiptText
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.util.openUrl
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.KeyValueStyle
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.util.nowIso
import kotlinx.coroutines.launch

// The header Receipt / Send-reminder actions are always on (real generateReceipt /
// sendInvoiceReminder callables). The Payments panel renders the REAL per-invoice
// join first (paymentsForInvoice via the populated Payment.invoiceId); when no
// payment is linked yet it falls back to the BROADER, kinfolk-level "payments for
// this client" list under a clearly-labeled "NOT INVOICE-LINKED" banner so the
// operator is never misled into thinking those belong to THIS invoice.

@Composable
fun InvoiceDetailScreen(invoiceId: String, onBack: () -> Unit = {}) {
    val client = remember { FirestoreClient() }
    // P0-FLICKER: hoist Flow construction via remember so the same Flow survives recomposition.
    val streamState by remember { client.invoicesStream() }.collectAsState(initial = FirestoreResult.Loading)

    val state = invoiceDetailStateFor(invoiceId, streamState)

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "Invoices · The Den",
            title      = "Invoice",
            accentTail = "Detail.",
            subtitle   = "Full billing record.",
            trailing   = {
                AuntieIconButton(
                    icon               = Lucide.X,
                    contentDescription = "Back to invoices",
                    onClick            = onBack,
                    size               = 38.dp,
                )
            },
        )
        Spacer(Modifier.height(20.dp))

        when (state) {
            InvoiceDetailState.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(3) { ShimmerCard(height = 80.dp) }
                }

            is InvoiceDetailState.Err ->
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Couldn't load invoice",
                    icon  = Lucide.CircleAlert,
                    body  = {
                        Text(
                            state.message,
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    },
                )

            InvoiceDetailState.NotFound ->
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Invoice not found",
                    icon  = Lucide.CircleAlert,
                    body  = {
                        Text(
                            "This invoice may have been removed.",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    },
                )

            is InvoiceDetailState.Loaded -> InvoiceDetailBody(
                invoice = state.invoice,
                client  = client,
            )
        }
    }
}

@Composable
private fun InvoiceDetailBody(invoice: Invoice, client: FirestoreClient) {
    val c = AuntieTheme.colors
    val todayKey = nowIso().take(10)
    val status   = invoiceStatusFor(invoice, todayKey)

    val (statusTone, statusText, statusIcon) = when (status) {
        InvoiceStatus.PAID        -> Triple(AuntieStatusTone.Success, "PAID", Lucide.CircleCheckBig)
        InvoiceStatus.OVERDUE     -> Triple(AuntieStatusTone.Error, "OVERDUE", Lucide.CircleAlert)
        InvoiceStatus.OUTSTANDING -> Triple(AuntieStatusTone.Warning, "OUTSTANDING", Lucide.Clock)
    }
    val accent     = statusTone.colorOf()
    val amountTone = if (status == InvoiceStatus.PAID) KeyValueStyle.AccentSuccess else KeyValueStyle.AccentError

    // Sessions for this kinfolk (for the link editor + linked-session rows).
    // P0-FLICKER: remember keyed on kinfolkId so a re-render keeps the same Flow.
    val sessionsState by remember(invoice.kinfolkId) { client.sessionsForKinfolkStream(invoice.kinfolkId) }
        .collectAsState(initial = FirestoreResult.Loading)

    // Payments stream (filtered to this kinfolk as a disclosed heuristic only).
    val paymentsState by remember { client.paymentsStream() }
        .collectAsState(initial = FirestoreResult.Loading)

    // Business settings → operator-entered payment handles for the "How to pay" panel.
    val settingsState by remember { client.businessSettingsStream() }
        .collectAsState(initial = FirestoreResult.Loading)
    val businessSettings = (settingsState as? FirestoreResult.Data)?.value

    val allSessions: List<KinCareSession> = (sessionsState as? FirestoreResult.Data)?.value.orEmpty()
    val linkedSessions = allSessions.filter { it._id in invoice.sessionIds }

    val allPayments: List<Payment> = (paymentsState as? FirestoreResult.Data)?.value.orEmpty()
    // REAL per-invoice join via the populated Payment.invoiceId (spec 17 item 5).
    val linkedPayments = paymentsForInvoice(allPayments, invoice._id)
    // Disclosed kinfolk-level heuristic kept as a secondary, flag-gated extra only.
    val clientPayments = paymentsForKinfolk(allPayments, invoice.kinfolkId)

    // Record-payment dialog (spec 17 item 6): prefilled from the invoice, stamps
    // invoiceId so the join above is populated. Uses the existing recordPayment callable.
    var showRecordPayment by remember { mutableStateOf(false) }
    var recordingPayment  by remember { mutableStateOf(false) }

    // Edit-mode state
    var editMode     by remember { mutableStateOf(false) }
    var pendingIds   by remember(invoice._id) { mutableStateOf(invoice.sessionIds.toSet()) }
    var saveLoading  by remember { mutableStateOf(false) }
    var receiptLoading  by remember { mutableStateOf(false) }
    var reminderLoading by remember { mutableStateOf(false) }
    var pdfLoading      by remember { mutableStateOf(false) }
    var toastMsg     by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastIsError by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    fun showToast(msg: String, isError: Boolean) {
        toastMsg = msg; toastIsError = isError; toastVisible = true
    }

    fun saveLinks() {
        val newIds  = pendingIds.toList()
        val oldIds  = invoice.sessionIds.toSet()
        val added   = pendingIds - oldIds
        val removed = oldIds - pendingIds
        saveLoading = true
        scope.launch {
            when (val r = client.updateInvoiceSessionIds(invoice._id, newIds)) {
                is WriteResult.Err -> {
                    saveLoading = false
                    showToast("Save failed: ${r.message}", true)
                    return@launch
                }
                is WriteResult.Ok  -> Unit
            }
            // Bidirectional sync of the session -> invoice back-reference.
            // WARNING-40: collect each WriteResult; surface partial failures fail-loud.
            var failCount = 0
            val addResults   = added.map   { sid -> client.updateSessionInvoiceId(sid, invoice._id) }
            val removeResults = removed.map { sid -> client.updateSessionInvoiceId(sid, "") }
            for (r in addResults + removeResults) {
                if (r is WriteResult.Err) failCount++
            }
            saveLoading = false
            if (failCount > 0) {
                showToast("Saved invoice links but $failCount session back-reference(s) failed to update. Retry to fix.", true)
                // Stay in edit mode so the operator can retry; the invoice sessionIds ARE saved.
            } else {
                editMode = false
                showToast("Sessions linked.", false)
            }
        }
    }

    // ── Edit dialog: "Link Sessions" ──────────────────────────────────────────
    LinkSessionsDialog(
        visible       = editMode,
        sessionsState = sessionsState,
        pendingIds    = pendingIds,
        saveLoading   = saveLoading,
        onToggle      = { sid ->
            pendingIds = if (sid in pendingIds) pendingIds - sid else pendingIds + sid
        },
        onCancel      = { editMode = false },
        onSave        = { saveLinks() },
    )

    // ── Record-payment dialog (writes Payment.invoiceId) ──────────────────────
    RecordPaymentDialog(
        visible    = showRecordPayment,
        invoice    = invoice,
        submitting = recordingPayment,
        onDismiss  = { showRecordPayment = false },
        onSubmit   = { payment ->
            recordingPayment = true
            scope.launch {
                when (val r = client.recordPayment(payment)) {
                    is WriteResult.Ok  -> {
                        recordingPayment = false
                        showRecordPayment = false
                        showToast("Payment recorded.", false)
                    }
                    is WriteResult.Err -> {
                        recordingPayment = false
                        showToast("Couldn't record payment: ${r.message}", true)
                    }
                }
            }
        },
    )

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        StatusToast(
            visible   = toastVisible,
            message   = toastMsg,
            kind      = if (toastIsError) ToastKind.Error else ToastKind.Success,
            onDismiss = { toastVisible = false },
        )

        // ── Header status badge (accent-tinted full-width bar) ─────────────────
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .background(accent.copy(alpha = 0.10f))
                .border(AuntieTheme.dims.borderHairline, accent.copy(alpha = 0.40f), RoundedCornerShape(18.dp))
                .padding(horizontal = 20.dp, vertical = 18.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text  = "Invoice #${invoice.invoiceNumber.ifBlank { "-" }}",
                    style = AuntieTheme.typography.titleLarge,
                    color = c.textPrimary,
                )
                if (invoice.kinfolkName.isNotBlank()) {
                    Text(invoice.kinfolkName, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            AuntieStatusPill(
                label       = statusText,
                tone        = statusTone,
                mono        = true,
                leadingIcon = statusIcon,
            )
        }

        // ── Amount stat row ────────────────────────────────────────────────────
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatCard(
                label = "Total",
                value = formatMoney(invoice.total),
                trend = invoice.date.ifBlank { "no date" },
                tone  = AuntieStatusTone.Orange,
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label   = "Amount due",
                value   = formatMoney(invoice.amountDue),
                trend   = when (status) {
                    InvoiceStatus.PAID        -> "paid in full"
                    InvoiceStatus.OVERDUE     -> "past due ${invoice.dueDate.trim().take(10)}"
                    InvoiceStatus.OUTSTANDING -> "due ${invoice.dueDate.trim().take(10).ifBlank { "soon" }}"
                },
                tone    = statusTone,
                feature = true,
                modifier = Modifier.weight(1f),
            )
        }

        // Header actions: Generate receipt (generateReceipt callable) and Send
        // reminder (sendInvoiceReminder callable). Both real, fail-loud via toast.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GhostButton(
                label   = if (receiptLoading) "Generating..." else "Generate receipt",
                onClick = {
                    if (receiptLoading || reminderLoading) return@GhostButton
                    receiptLoading = true
                    scope.launch {
                        when (val r = client.generateReceipt(invoice._id)) {
                            is WriteResult.Err -> showToast("Couldn't generate receipt: ${r.message}", true)
                            is WriteResult.Ok  -> showToast("Receipt generated.", false)
                        }
                        receiptLoading = false
                    }
                },
                enabled = !receiptLoading && !reminderLoading,
                leading = { Icon(Lucide.ReceiptText, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            GhostButton(
                label   = if (reminderLoading) "Sending..." else "Send reminder",
                onClick = {
                    if (receiptLoading || reminderLoading) return@GhostButton
                    reminderLoading = true
                    scope.launch {
                        when (val r = client.sendInvoiceReminder(invoice._id)) {
                            is WriteResult.Err -> showToast("Couldn't send reminder: ${r.message}", true)
                            is WriteResult.Ok  -> showToast("Reminder sent.", false)
                        }
                        reminderLoading = false
                    }
                },
                enabled = !receiptLoading && !reminderLoading,
                leading = { Icon(Lucide.MessageSquare, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            // Stage 3 / 16.2: render + open a real invoice PDF (generateInvoicePdf
            // callable -> Cloud Storage download URL -> openUrl: a NEW browser tab
            // on web (window.open _blank, not a same-tab navigation that would drop
            // the admin SPA) and Desktop.browse on desktop.
            GhostButton(
                label   = if (pdfLoading) "Preparing..." else "Download PDF",
                onClick = {
                    if (pdfLoading) return@GhostButton
                    pdfLoading = true
                    scope.launch {
                        when (val r = client.generateInvoicePdf(invoice._id)) {
                            is WriteResult.Err -> showToast("Couldn't make the PDF: ${r.message}", true)
                            is WriteResult.Ok  -> { openUrl(r.value); showToast("Opening invoice PDF in a new tab.", false) }
                        }
                        pdfLoading = false
                    }
                },
                enabled = !pdfLoading,
                leading = { Icon(Lucide.FileText, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
        }

        // ── Billing panel ────────────────────────────────────────────────────
        DenPanel(title = "Billing") {
            Column {
                DetailRow("Client",   invoice.client.ifBlank { "-" })
                DetailRow("Date",     invoice.date.ifBlank { "-" })
                DetailRow("Due date", invoice.dueDate.ifBlank { "-" })
                if (invoice.terms.isNotBlank()) DetailRow("Terms", invoice.terms)
                if (invoice.address.isNotBlank()) DetailRow("Address", invoice.address)
            }
        }

        // ── Amounts panel ──────────────────────────────────────────────────────
        DenPanel(title = "Amounts") {
            Column {
                DetailRow(
                    "Total",
                    formatMoney(invoice.total),
                    style     = KeyValueStyle.Total,
                    valueMono = false,
                )
                DetailRow(
                    "Amount due",
                    formatMoney(invoice.amountDue),
                    style     = amountTone,
                    valueMono = true,
                )
                if (invoice.discount.isNotBlank() && invoice.discount != "0%" && invoice.discount != "0.00%") {
                    DetailRow("Discount", invoice.discount, style = KeyValueStyle.AccentPrimary)
                }
            }
        }

        // ── Payments panel ─────────────────────────────────────────────────────
        // Real per-invoice list via the populated Payment.invoiceId join (spec 17
        // item 5). Record-payment (item 6) writes that link so the list grows. The
        // raw paymentsHistory text is kept as a secondary record; the kinfolk-level
        // heuristic survives only as a disclosed, flag-gated extra.
        DenPanel(
            title = "Payments",
            trailing = {
                GhostButton(label = "Record payment", onClick = { showRecordPayment = true })
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (invoice.paymentsHistory.isNotBlank()) {
                    Text(
                        invoice.paymentsHistory,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }

                when {
                    paymentsState is FirestoreResult.Loading ->
                        repeat(2) { ShimmerCard(height = 40.dp) }
                    paymentsState is FirestoreResult.Error ->
                        EmptyHint(
                            "Couldn't load payments: ${(paymentsState as FirestoreResult.Error).message}",
                            error = true,
                        )
                    linkedPayments.isNotEmpty() ->
                        Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                            linkedPayments.forEachIndexed { idx, p ->
                                PaymentRow(p, showDivider = idx > 0)
                            }
                        }
                    // No invoice-linked payment yet. Show the disclosed kinfolk-level
                    // payment match as a clearly-labeled fallback (always on now);
                    // otherwise fail loud below.
                    clientPayments.isNotEmpty() -> {
                        AuntieBanner(
                            tone      = AuntieBannerTone.Warning,
                            pillLabel = "NOT INVOICE-LINKED",
                            body      = {
                                Text(
                                    "No payment is linked to this invoice yet. The rows below are matched by client only.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            },
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                            clientPayments.forEachIndexed { idx, p ->
                                PaymentRow(p, showDivider = idx > 0)
                            }
                        }
                    }
                    invoice.paymentsHistory.isBlank() ->
                        EmptyHint("No payment recorded against this invoice yet. Use Record payment to log one.")
                }
            }
        }

        // ── Linked Sessions section ───────────────────────────────────────────
        LinkedSessionsSection(
            invoice         = invoice,
            linkedSessions  = linkedSessions,
            sessionsState   = sessionsState,
            onOpenEdit      = { pendingIds = invoice.sessionIds.toSet(); editMode = true },
        )

        // How-to-pay: operator-entered Venmo/PayPal/Cash App handles (Payment Options
        // settings). Hidden entirely when none are configured.
        HowToPayPanel(settings = businessSettings)
    }
}

@Composable
private fun HowToPayPanel(settings: BusinessSettings?) {
    val methods = buildList {
        settings?.venmoHandle?.takeIf { it.isNotBlank() }?.let { add("Venmo" to it) }
        settings?.paypalHandle?.takeIf { it.isNotBlank() }?.let { add("PayPal" to it) }
        settings?.cashappHandle?.takeIf { it.isNotBlank() }?.let { add("Cash App" to it) }
    }
    if (methods.isEmpty()) return
    val c = AuntieTheme.colors
    DenPanel(title = "How to pay", subtitle = "Send payment to any of these.") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            methods.forEach { (label, handle) ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    Text(handle, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                }
            }
        }
    }
}

/** Resolve a tone to its brand color via the shared AuntieStatusTone.color extension. */
@Composable
private fun AuntieStatusTone.colorOf() = this.color(AuntieTheme.colors)

@Composable
private fun PaymentRow(payment: Payment, showDivider: Boolean) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
    val dateLabel = payment.date.take(10).ifBlank { "-" }
    val method = payment.paymentMethod.ifBlank { "payment" }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                if (showDivider) {
                    val h = hairline.toPx()
                    drawLine(
                        color       = ruleColor,
                        start       = Offset(0f, h / 2f),
                        end         = Offset(size.width, h / 2f),
                        strokeWidth = h,
                    )
                }
            }
            .padding(vertical = 9.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(method, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            Text(dateLabel, style = AuntieTheme.typography.labelSmall, color = c.textDim)
        }
        Text(
            formatMoney(payment.amount + payment.tip),
            style = AuntieTheme.typography.bodyMedium,
            color = c.success,
        )
    }
}

/**
 * Record-payment dialog prefilled from the invoice. Stamps invoiceId/invoiceNumber
 * via [buildInvoicePayment] so the per-invoice join is populated (spec 17 item 6).
 */
@Composable
private fun RecordPaymentDialog(
    visible: Boolean,
    invoice: Invoice,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (Payment) -> Unit,
) {
    var amount    by remember(invoice._id, visible) { mutableStateOf(if (invoice.amountDue > 0.0) invoice.amountDue.toString() else "") }
    var method    by remember(invoice._id, visible) { mutableStateOf("") }
    var reference by remember(invoice._id, visible) { mutableStateOf("") }
    var date      by remember(invoice._id, visible) { mutableStateOf("") }
    var notes     by remember(invoice._id, visible) { mutableStateOf("") }

    val amountValue = amount.trim().toDoubleOrNull()
    val canSave = amountValue != null && amountValue > 0.0 && method.isNotBlank()

    AuntieDialog(
        visible   = visible,
        title     = "Record payment",
        onDismiss = onDismiss,
        hint      = "Logs a payment against invoice #${invoice.invoiceNumber.ifBlank { "-" }}.",
        maxWidth  = 460.dp,
        footer    = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            Spacer(Modifier.width(8.dp))
            PrimaryButton(
                label   = if (submitting) "Saving" else "Record payment",
                enabled = canSave && !submitting,
                onClick = { onSubmit(buildInvoicePayment(invoice, amountValue ?: 0.0, method, reference, date, notes)) },
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BottomBorderField(amount, { amount = it }, label = "Amount *", keyboardType = KeyboardType.Decimal, modifier = Modifier.fillMaxWidth())
            BottomBorderField(method, { method = it }, label = "Method *", placeholder = "card, cash, transfer...", modifier = Modifier.fillMaxWidth())
            BottomBorderField(reference, { reference = it }, label = "Reference #", modifier = Modifier.fillMaxWidth())
            BottomBorderField(date, { date = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth())
            BottomBorderField(notes, { notes = it }, label = "Notes", modifier = Modifier.fillMaxWidth())
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinkSessionsDialog(
    visible: Boolean,
    sessionsState: FirestoreResult<List<KinCareSession>>,
    pendingIds: Set<String>,
    saveLoading: Boolean,
    onToggle: (String) -> Unit,
    onCancel: () -> Unit,
    onSave: () -> Unit,
) {
    val c = AuntieTheme.colors
    AuntieDialog(
        visible   = visible,
        title     = "Link Sessions",
        onDismiss = onCancel,
        maxWidth  = 440.dp,
        closeIcon = Lucide.X,
        footer    = {
            GhostButton(label = "Cancel", onClick = onCancel)
            PrimaryButton(label = "Save", onClick = onSave, loading = saveLoading)
        },
    ) {
        when (val s = sessionsState) {
            FirestoreResult.Loading -> repeat(3) { ShimmerCard(height = 40.dp) }
            is FirestoreResult.Error -> Text(
                "Couldn't load sessions: ${s.message}",
                style = AuntieTheme.typography.bodySmall,
                color = c.error,
            )
            is FirestoreResult.Data -> {
                if (s.value.isEmpty()) {
                    Text(
                        "No sessions found for this kinfolk.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                } else {
                    FlowRow(
                        modifier              = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement   = Arrangement.spacedBy(8.dp),
                    ) {
                        s.value.forEach { session ->
                            val dateLabel = session.completedAt.take(10)
                                .ifBlank { session.startTime.take(10) }
                                .ifBlank { "-" }
                            val chipLabel = "${session.serviceType.ifBlank { "Session" }} · $dateLabel"
                            AuntieChip(
                                label    = chipLabel,
                                selected = session._id in pendingIds,
                                tone     = AuntieChipTone.Orange,
                                onClick  = { onToggle(session._id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LinkedSessionsSection(
    invoice: Invoice,
    linkedSessions: List<KinCareSession>,
    sessionsState: FirestoreResult<List<KinCareSession>>,
    onOpenEdit: () -> Unit,
) {
    val c = AuntieTheme.colors
    val attributionLabel = when (invoice.attribution) {
        "greedy_by_date" -> "auto"
        "manual"         -> "manual"
        else             -> null
    }
    DenPanel(
        title    = "Linked Sessions",
        subtitle = "Visits billed on this invoice.",
        trailing = {
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (attributionLabel != null) {
                    AuntieChip(label = attributionLabel, tone = AuntieChipTone.Orange)
                }
                AuntieIconButton(
                    icon               = Lucide.Pencil,
                    contentDescription = "Edit linked sessions",
                    onClick            = onOpenEdit,
                    size               = 30.dp,
                )
            }
        },
    ) {
        when {
            sessionsState is FirestoreResult.Loading -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(2) { ShimmerCard(height = 40.dp) }
            }

            sessionsState is FirestoreResult.Error -> EmptyHint(
                "Couldn't load sessions: ${(sessionsState as FirestoreResult.Error).message}",
                error = true,
            )

            invoice.kinfolkId.isBlank() -> AuntieBanner(
                tone      = AuntieBannerTone.Warning,
                pillLabel = "CANNOT LINK",
                icon      = Lucide.CircleAlert,
                body      = {
                    Text(
                        "This invoice has no client (kinfolk) on record, so its sessions cannot be matched. Set a client to link visits.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                },
            )

            linkedSessions.isEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                EmptyHint("No linked sessions yet.")
                GhostButton(
                    label   = "Link sessions",
                    onClick = onOpenEdit,
                    leading = { Icon(Lucide.Link, contentDescription = null, modifier = Modifier.size(14.dp)) },
                )
            }

            else -> Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                linkedSessions.forEachIndexed { idx, session ->
                    LinkedSessionRow(session, showDivider = idx > 0)
                }
            }
        }
    }
}

@Composable
private fun LinkedSessionRow(session: KinCareSession, showDivider: Boolean) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
    val dateLabel = session.completedAt.take(10).ifBlank { session.startTime.take(10) }.ifBlank { "-" }
    val statusLabel = session.status.lowercase().replace('_', ' ')
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // Top hairline rule between rows (mockup .ses border-top), suppressed on the first row.
            .drawBehind {
                if (showDivider) {
                    val h = hairline.toPx()
                    drawLine(
                        color       = ruleColor,
                        start       = Offset(0f, h / 2f),
                        end         = Offset(size.width, h / 2f),
                        strokeWidth = h,
                    )
                }
            }
            .padding(vertical = 9.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                session.serviceType.ifBlank { "Service" },
                style = AuntieTheme.typography.bodySmall,
                color = c.textPrimary,
            )
            Text(dateLabel, style = AuntieTheme.typography.labelSmall, color = c.textDim)
        }
        AuntieStatusPill(
            label = statusLabel,
            tone  = AuntieStatusTone.Neutral,
        )
    }
}

@Composable
private fun DetailRow(
    label: String,
    value: String,
    style: KeyValueStyle = KeyValueStyle.Default,
    valueMono: Boolean = false,
) {
    AuntieKeyValueRow(
        label       = label,
        value       = value,
        valueStyle  = style,
        valueMono   = valueMono,
        showDivider = true,
    )
}
