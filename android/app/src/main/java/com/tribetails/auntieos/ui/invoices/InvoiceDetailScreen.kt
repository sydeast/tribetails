package com.tribetails.auntieos.ui.invoices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import android.content.Intent
import android.net.Uri
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Link
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageSquare
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.X
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.KeyValueStyle
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.ShimmerCard
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.components.color
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.LocalDate

// Stage 2 tail: header Receipt / Send-reminder actions and draft Review-and-send are
// wired to real callables (generateReceipt / sendInvoiceReminder / postInvoiceEvent).
// The former FF_INVOICE_HEADER_ACTIONS dark gate is retired.

// The Payments panel below renders the REAL per-invoice join (uiState.linkedPayments,
// built from the populated Payment.invoiceId in InvoiceDetailViewModel). When no
// payment is confidently linked yet, it falls back to the DISCLOSED client-side
// heuristic (uiState.clientPayments: same-kinfolk payments with no invoiceId link)
// under a visible "matched by client only" warning. The former
// invoices.clientPaymentsHeuristic flag is retired: the fallback is now always on,
// just always disclosed (never implying those payments belong to THIS invoice).

@Composable
fun InvoiceDetailScreen(
    invoiceId: String,
    onBack: () -> Unit,
    viewModel: InvoiceDetailViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(invoiceId) {
        viewModel.loadInvoice(invoiceId)
    }

    // Stage 3 / 16.2: open the generated invoice PDF URL in the system
    // viewer/browser, then clear the one-shot so a recomposition won't re-open it.
    LaunchedEffect(uiState.pdfUrlToOpen) {
        uiState.pdfUrlToOpen?.let { url ->
            runCatching {
                context.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }.onFailure { viewModel.pdfOpenFailed() } // fail-loud: no silent no-op
            viewModel.consumePdfUrl()
        }
    }

    // Session-link edit dialog
    if (uiState.editMode) {
        LinkSessionsDialog(
            available   = uiState.availableSessions,
            selectedIds = uiState.pendingSessionIds,
            onToggle    = { viewModel.toggleSessionInPending(it) },
            onSave      = { viewModel.saveLinks() },
            onDismiss   = { viewModel.closeEditMode() },
            saveLoading = uiState.saveLoading,
        )
    }

    AuntieScreenScaffold(onBack = onBack) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            item {
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
            }

            // Toast overlay (kept above the body, mirroring the existing wiring).
            item {
                StatusToast(
                    visible   = uiState.toastVisible,
                    message   = uiState.toastMessage,
                    kind      = if (uiState.toastIsError) ToastKind.Error else ToastKind.Success,
                    onDismiss = { viewModel.dismissToast() },
                )
            }

            when {
                uiState.isLoading -> {
                    items(3) { ShimmerCard(height = 80) }
                }

                uiState.error != null -> {
                    item {
                        AuntieBanner(
                            tone  = AuntieBannerTone.Error,
                            title = "Couldn't load invoice",
                            icon  = Lucide.CircleAlert,
                            body  = {
                                Text(
                                    uiState.error ?: "",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            },
                        )
                    }
                    item {
                        PrimaryButton(
                            label = "Retry",
                            onClick = { viewModel.loadInvoice(invoiceId) },
                        )
                    }
                }

                uiState.invoice != null -> {
                    val invoice = uiState.invoice!!
                    val linkedSessions = uiState.availableSessions.filter {
                        it.id in invoice.sessionIds
                    }
                    invoiceDetailBody(
                        scope             = this,
                        invoice           = invoice,
                        linkedSessions    = linkedSessions,
                        sessionsLoading   = uiState.sessionsLoading,
                        linkedPayments    = uiState.linkedPayments,
                        clientPayments    = uiState.clientPayments,
                        generatingReceipt = uiState.generatingReceipt,
                        sendingReminder   = uiState.sendingReminder,
                        sendingDraft      = uiState.sendingDraft,
                        generatingPdf     = uiState.generatingPdf,
                        businessSettings  = uiState.businessSettings,
                        onOpenEdit        = { viewModel.openEditMode() },
                        onRecordPayment   = { viewModel.openRecordPayment() },
                        onGenerateReceipt = { viewModel.generateReceipt() },
                        onSendReminder    = { viewModel.sendReminder() },
                        onSendDraft       = { viewModel.reviewAndSendDraft() },
                        onDownloadPdf     = { viewModel.downloadPdf() },
                    )
                }
            }
        }
    }

    // ── Record-payment dialog (writes Payment.invoiceId) ──────────────────────────
    if (uiState.showRecordPayment) {
        uiState.invoice?.let { inv ->
            RecordPaymentDialog(
                invoice    = inv,
                submitting = uiState.recordingPayment,
                onDismiss  = { viewModel.closeRecordPayment() },
                onSubmit   = { payment -> viewModel.recordPayment(payment) },
            )
        }
    }
}

/**
 * Emits the loaded-invoice body items into the parent [LazyListScope]. Mirrors the
 * web spec's InvoiceDetailBody: header status bar, amount stat row, billing /
 * amounts / payments / linked-sessions panels, with the same fail-loud gating.
 */
private fun invoiceDetailBody(
    scope: androidx.compose.foundation.lazy.LazyListScope,
    invoice: Invoice,
    linkedSessions: List<KinCareSession>,
    sessionsLoading: Boolean,
    linkedPayments: List<com.tribetails.auntieos.data.model.Payment>,
    clientPayments: List<com.tribetails.auntieos.data.model.Payment>,
    generatingReceipt: Boolean,
    sendingReminder: Boolean,
    sendingDraft: Boolean,
    generatingPdf: Boolean,
    businessSettings: com.tribetails.auntieos.data.model.BusinessSettings?,
    onOpenEdit: () -> Unit,
    onRecordPayment: () -> Unit,
    onGenerateReceipt: () -> Unit,
    onSendReminder: () -> Unit,
    onSendDraft: () -> Unit,
    onDownloadPdf: () -> Unit,
) = with(scope) {
    val todayKey = runCatching { LocalDate.now().toString() }.getOrDefault("")
    val status   = invoiceStatusFor(invoice, todayKey)

    // ── Header status bar (accent-tinted full-width) ────────────────────────────
    item {
        InvoiceHeaderBar(invoice = invoice, status = status)
    }

    // ── Amount stat row ─────────────────────────────────────────────────────────
    item {
        val (statusTone, _, _) = statusTriple(status)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatCard(
                label    = "Total",
                value    = formatMoney(invoice.total),
                trend    = invoice.date.ifBlank { "no date" },
                tone     = AuntieStatusTone.Orange,
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "Amount due",
                value = formatMoney(invoice.amountDue),
                trend = when (status) {
                    InvoiceStatus.PAID        -> "paid in full"
                    InvoiceStatus.OVERDUE     -> "past due ${invoice.dueDate.trim().take(10)}"
                    InvoiceStatus.OUTSTANDING -> "due ${invoice.dueDate.trim().take(10).ifBlank { "soon" }}"
                },
                tone     = statusTone,
                feature  = true,
                modifier = Modifier.weight(1f),
            )
        }
    }

    // Header actions (Stage 2 tail): Generate receipt + Send reminder, wired to the
    // generateReceipt / sendInvoiceReminder callables. Reminder is suppressed once the
    // invoice is paid (the server rejects a reminder on a paid invoice anyway).
    item {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            GhostButton(
                label   = if (generatingReceipt) "Generating…" else "Generate receipt",
                onClick = onGenerateReceipt,
                enabled = !generatingReceipt,
            )
            // Stage 3 / 16.2: render + open a real invoice PDF (generateInvoicePdf
            // callable -> Cloud Storage download URL -> system viewer).
            GhostButton(
                label   = if (generatingPdf) "Preparing…" else "Download PDF",
                onClick = onDownloadPdf,
                enabled = !generatingPdf,
                leading = {
                    Icon(Lucide.FileText, contentDescription = null, modifier = Modifier.size(14.dp))
                },
            )
            if (status != InvoiceStatus.PAID) {
                GhostButton(
                    label   = if (sendingReminder) "Sending…" else "Send reminder",
                    onClick = onSendReminder,
                    enabled = !sendingReminder,
                    leading = {
                        Icon(
                            Lucide.MessageSquare,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                        )
                    },
                )
            }
        }
    }

    // Draft review-and-send (Stage 2 tail): only on a DRAFT invoice, wired to the
    // postInvoiceEvent callable (status -> "sent"). Fail-loud if the invoice has no
    // client: the action stays present but the VM surfaces the precondition.
    if (isDraftInvoice(invoice)) {
        item {
            AuntieBanner(
                tone      = AuntieBannerTone.Warning,
                pillLabel = "DRAFT",
                icon      = Lucide.Clock,
                trailing  = {
                    PrimaryButton(
                        label   = "Review and send",
                        onClick = onSendDraft,
                        loading = sendingDraft,
                        enabled = !sendingDraft,
                    )
                },
                body = {
                    Text(
                        "This invoice is still a draft. Review it, then send it to notify the client.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                },
            )
        }
    }

    // ── Billing panel ───────────────────────────────────────────────────────────
    item {
        DenPanel(title = "Billing") {
            Column {
                DetailRow("Client",   invoice.client.ifBlank { "-" })
                DetailRow("Date",     invoice.date.ifBlank { "-" })
                DetailRow("Due date", invoice.dueDate.ifBlank { "-" })
                if (invoice.terms.isNotBlank()) DetailRow("Terms", invoice.terms)
                if (invoice.address.isNotBlank()) DetailRow("Address", invoice.address)
            }
        }
    }

    // ── Amounts panel ─────────────────────────────────────────────────────────────
    item {
        val amountTone =
            if (status == InvoiceStatus.PAID) KeyValueStyle.AccentSuccess else KeyValueStyle.AccentError
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
    }

    // ── Payments panel ──────────────────────────────────────────────────────────
    // Real per-invoice list via the populated Payment.invoiceId join (spec 17 item 5).
    // Record-payment (item 6) writes that link so the list grows. The raw
    // paymentsHistory text is kept as a secondary record.
    item {
        DenPanel(
            title = "Payments",
            trailing = { GhostButton(label = "Record payment", onClick = onRecordPayment) },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (invoice.paymentsHistory.isNotBlank()) {
                    Text(
                        invoice.paymentsHistory,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }

                when {
                    // Confident per-invoice join via the populated Payment.invoiceId.
                    linkedPayments.isNotEmpty() ->
                        Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                            linkedPayments.forEachIndexed { idx, p ->
                                PaymentRow(p, showDivider = idx > 0)
                            }
                        }

                    // No invoice-linked payment yet. Surface the disclosed client-side
                    // fallback (same-kinfolk, unlinked payments) under a visible warning
                    // so it never reads as confirmed against THIS invoice. Fail-loud.
                    clientPayments.isNotEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        AuntieBanner(
                            tone      = AuntieBannerTone.Warning,
                            pillLabel = "NOT INVOICE-LINKED",
                            icon      = Lucide.CircleAlert,
                            body      = {
                                Text(
                                    "No payment is linked to this invoice yet. The rows below are matched by client only.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
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
    }

    // ── How to pay (A8 Payments) ─────────────────────────────────────────────────
    // Only when the operator has entered at least one handle (else nothing renders —
    // no fake methods).
    val payLines = paymentMethodLines(businessSettings)
    if (payLines.isNotEmpty()) {
        item {
            DenPanel(title = "How to pay") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    payLines.forEach { (method, handle) ->
                        AuntieKeyValueRow(label = method, value = handle)
                    }
                }
            }
        }
    }

    // ── Linked Sessions section ──────────────────────────────────────────────────
    item {
        LinkedSessionsSection(
            invoice         = invoice,
            linkedSessions  = linkedSessions,
            sessionsLoading = sessionsLoading,
            onOpenEdit      = onOpenEdit,
        )
    }
}

/** A8: non-blank payment handles as (method, handle) rows for the "How to pay" panel. */
private fun paymentMethodLines(bs: com.tribetails.auntieos.data.model.BusinessSettings?): List<Pair<String, String>> {
    bs ?: return emptyList()
    return buildList {
        if (bs.venmoHandle.isNotBlank())   add("Venmo"   to bs.venmoHandle.trim())
        if (bs.paypalHandle.isNotBlank())  add("PayPal"  to bs.paypalHandle.trim())
        if (bs.cashappHandle.isNotBlank()) add("Cash App" to bs.cashappHandle.trim())
    }
}

@Composable
private fun InvoiceHeaderBar(invoice: Invoice, status: InvoiceStatus) {
    val c = AuntieTheme.colors
    val (statusTone, statusText, statusIcon) = statusTriple(status)
    val accent = statusTone.color(c)

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
}

@Composable
private fun LinkedSessionsSection(
    invoice: Invoice,
    linkedSessions: List<KinCareSession>,
    sessionsLoading: Boolean,
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
                    AuntieChip(label = attributionLabel, selected = true, onClick = {})
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
            sessionsLoading -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(2) { ShimmerCard(height = 40) }
            }

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
    val statusText = session.status.lowercase().replace('_', ' ')
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // Top hairline rule between rows, suppressed on the first row.
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
            label = statusText,
            tone  = AuntieStatusTone.Neutral,
        )
    }
}

@Composable
private fun PaymentRow(payment: Payment, showDivider: Boolean) {
    val c = AuntieTheme.colors
    val dateLabel = payment.date.take(10).ifBlank { "-" }
    val method = payment.paymentMethod.ifBlank { "payment" }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(method, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            Text(dateLabel, style = AuntieTheme.typography.labelSmall, color = c.textDim)
        }
        Text(formatMoney(payment.amount + payment.tip), style = AuntieTheme.typography.bodyMedium, color = c.success)
    }
}

/**
 * Record-payment dialog prefilled from the invoice. Stamps invoiceId/invoiceNumber
 * via [buildInvoicePayment] so the per-invoice join populates (spec 17 item 6).
 */
@Composable
private fun RecordPaymentDialog(
    invoice: Invoice,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (Payment) -> Unit,
) {
    var amount    by remember(invoice.id) { mutableStateOf(if (invoice.amountDue > 0.0) invoice.amountDue.toString() else "") }
    var method    by remember(invoice.id) { mutableStateOf("") }
    var reference by remember(invoice.id) { mutableStateOf("") }
    var date      by remember(invoice.id) { mutableStateOf("") }
    var notes     by remember(invoice.id) { mutableStateOf("") }

    val amountValue = amount.trim().toDoubleOrNull()
    val canSave = amountValue != null && amountValue > 0.0 && method.isNotBlank()

    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Record payment",
        confirmButton = {
            PrimaryButton(
                label   = "Record payment",
                onClick = { onSubmit(buildInvoicePayment(invoice, amountValue ?: 0.0, method, reference, date, notes)) },
                loading = submitting,
                enabled = canSave && !submitting,
            )
        },
        dismissButton = { GhostButton(label = "Cancel", onClick = onDismiss) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieField(value = amount, onValueChange = { amount = it }, label = "Amount *", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            AuntieField(value = method, onValueChange = { method = it }, label = "Method *", placeholder = "card, cash, transfer...", modifier = Modifier.fillMaxWidth())
            AuntieField(value = reference, onValueChange = { reference = it }, label = "Reference #", modifier = Modifier.fillMaxWidth())
            AuntieField(value = date, onValueChange = { date = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth())
            AuntieField(value = notes, onValueChange = { notes = it }, label = "Notes", modifier = Modifier.fillMaxWidth())
        }
    }
}

// ── Edit dialog: "Link Sessions" ─────────────────────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LinkSessionsDialog(
    available: List<KinCareSession>,
    selectedIds: Set<String>,
    onToggle: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
    saveLoading: Boolean,
) {
    val c = AuntieTheme.colors
    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Link Sessions",
        confirmButton = {
            PrimaryButton(label = "Save", onClick = onSave, loading = saveLoading)
        },
        dismissButton = {
            GhostButton(label = "Cancel", onClick = onDismiss)
        },
    ) {
        if (available.isEmpty()) {
            Text(
                text  = "No sessions found for this kinfolk.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        } else {
            FlowRow(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement   = Arrangement.spacedBy(8.dp),
            ) {
                available.forEach { session ->
                    val dateLabel = session.completedAt.take(10)
                        .ifBlank { session.startTime.take(10) }
                        .ifBlank { "-" }
                    val chipLabel = "${session.serviceType.ifBlank { "Session" }} · $dateLabel"
                    AuntieChip(
                        label    = chipLabel,
                        selected = session.id in selectedIds,
                        onClick  = { onToggle(session.id) },
                    )
                }
            }
        }
    }
}

// ── Shared row helper ─────────────────────────────────────────────────────────

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

// ── Pure helpers (ported from the web spec so both surfaces resolve identically) ──

/** Resolves an [InvoiceStatus] to its (tone, label, leadingIcon) triple. */
private fun statusTriple(status: InvoiceStatus): Triple<AuntieStatusTone, String, androidx.compose.ui.graphics.vector.ImageVector> =
    when (status) {
        InvoiceStatus.PAID        -> Triple(AuntieStatusTone.Success, "PAID", Lucide.CircleCheckBig)
        InvoiceStatus.OVERDUE     -> Triple(AuntieStatusTone.Error, "OVERDUE", Lucide.CircleAlert)
        InvoiceStatus.OUTSTANDING -> Triple(AuntieStatusTone.Warning, "OUTSTANDING", Lucide.Clock)
    }

enum class InvoiceStatus { PAID, OVERDUE, OUTSTANDING }

/**
 * Pure status resolver, mirrored from the web InvoiceDetailState helper.
 * [todayKey] is an ISO date prefix (YYYY-MM-DD) for "today" so the comparison
 * stays testable and clock-free.
 *
 * - amountDue <= 0  -> PAID
 * - still owed AND dueDate parses to a date strictly before today -> OVERDUE
 * - otherwise -> OUTSTANDING
 */
private fun invoiceStatusFor(invoice: Invoice, todayKey: String): InvoiceStatus {
    if (invoice.amountDue <= 0.0) return InvoiceStatus.PAID
    val due = invoice.dueDate.trim().take(10)
    return if (isIsoDateBefore(due, todayKey)) InvoiceStatus.OVERDUE else InvoiceStatus.OUTSTANDING
}

/** True only when both look like YYYY-MM-DD and [a] is strictly before [b]. */
private fun isIsoDateBefore(a: String, b: String): Boolean {
    if (!looksLikeIsoDate(a) || !looksLikeIsoDate(b)) return false
    return a < b // lexicographic compare is correct for zero-padded YYYY-MM-DD
}

private fun looksLikeIsoDate(s: String): Boolean =
    s.length == 10 && s[4] == '-' && s[7] == '-' &&
        s[0].isDigit() && s[1].isDigit() && s[2].isDigit() && s[3].isDigit() &&
        s[5].isDigit() && s[6].isDigit() && s[8].isDigit() && s[9].isDigit()

/** Two-decimal currency formatting, mirrored from the web InvoiceFilters helper. */
private fun formatMoney(amount: Double): String {
    val abs     = if (amount < 0) -amount else amount
    val cents   = ((abs * 100) + 0.5).toLong()
    val whole   = cents / 100
    val frac    = cents % 100
    val fracStr = if (frac < 10) "0$frac" else "$frac"
    val sign    = if (amount < 0) "-" else ""
    return "$sign\$$whole.$fracStr"
}
