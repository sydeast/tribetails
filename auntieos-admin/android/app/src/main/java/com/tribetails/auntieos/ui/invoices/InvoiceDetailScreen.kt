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
import com.tribetails.auntieos.domain.InvoiceAction
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.invoiceActionsFor
import com.tribetails.auntieos.domain.invoiceIsOverdue
import com.tribetails.auntieos.domain.formatCentsUsd
import com.tribetails.auntieos.domain.invoicePartPaid
import com.tribetails.auntieos.domain.invoiceStateOrNull
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDialog
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
            available         = uiState.availableSessions,
            selectedIds       = uiState.pendingSessionIds,
            onToggle          = { viewModel.toggleSessionInPending(it) },
            onSave            = { viewModel.saveLinks() },
            onDismiss         = { viewModel.closeEditMode() },
            saveLoading       = uiState.saveLoading,
            billableIds       = uiState.billableSessionIds,
            unpricedIds       = uiState.unpricedSessionIds,
            rateCardLoaded    = uiState.rateCardLoaded,
            unplaceableIds    = uiState.unplaceableSessionIds,
            billableTruncated = uiState.billableTruncated,
            billableLoading   = uiState.billableLoading,
            billableError     = uiState.billableError,
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
                        archiving         = uiState.archiving,
                        onOpenEdit        = { viewModel.openEditMode() },
                        onRecordPayment   = { viewModel.openRecordPayment() },
                        onGenerateReceipt = { viewModel.generateReceipt() },
                        onSendReminder    = { viewModel.sendReminder() },
                        onSendDraft       = { viewModel.reviewAndSendDraft() },
                        onDownloadPdf     = { viewModel.downloadPdf() },
                        onArchive         = { viewModel.promptArchive() },
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

    // ── Archive / restore confirm ────────────────────────────────────────────────
    // Confirmed before anything is sent, and the copy says what archiving does
    // NOT do. That matters more than usual here: "archive" reads like "delete"
    // to most people, and this action is reversible and invisible to the
    // household, which is the opposite of what the word suggests.
    uiState.invoice?.let { inv ->
        val restoring = com.tribetails.auntieos.domain.invoiceIsArchived(inv)
        AuntieDialog(
            visible   = uiState.archivePrompt,
            title     = if (restoring) "Restore this invoice?" else "Archive this invoice?",
            onDismiss = { viewModel.dismissArchivePrompt() },
            footer = {
                GhostButton(label = "Cancel", onClick = { viewModel.dismissArchivePrompt() })
                PrimaryButton(
                    label = when {
                        restoring -> "Restore"
                        uiState.archiveForceOffered -> "Archive anyway"
                        else -> "Archive"
                    },
                    onClick = { viewModel.confirmArchive(uiState.archiveForceOffered) },
                    loading = uiState.archiving,
                )
            },
        ) {
            Text(
                text = if (restoring) {
                    "This puts the invoice back into the working list and back into the revenue and " +
                        "outstanding totals."
                } else {
                    "This takes the invoice out of the working list and out of the revenue and outstanding " +
                        "totals. It does NOT delete it, cancel it, or forgive what is owed, and the household " +
                        "can still see it and still pay it."
                },
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            if (!restoring && uiState.archiveForceOffered) {
                Text(
                    text = "This invoice still has money owing. Archiving it anyway writes that balance off " +
                        "the outstanding total, so nothing will remind you to collect it. That choice is " +
                        "recorded separately in the audit trail.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
            }
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
    archiving: Boolean,
    onOpenEdit: () -> Unit,
    onRecordPayment: () -> Unit,
    onGenerateReceipt: () -> Unit,
    onSendReminder: () -> Unit,
    onSendDraft: () -> Unit,
    onDownloadPdf: () -> Unit,
    onArchive: () -> Unit,
) = with(scope) {
    val todayKey = runCatching { LocalDate.now().toString() }.getOrDefault("")
    // State is the STORED stamp the server persisted (ADR-0002), decoded by the
    // same domain/InvoiceActions.kt the Den invoices list reads, so the two
    // screens can never disagree about what this invoice is - and neither can
    // re-derive it. The screen's old private invoiceStatusFor resolved
    // `amountDue <= 0` to PAID first, which read a draft, a quote, and a
    // credit as paid. Null means "no recognizable stamp": the raw stored
    // string renders and no action is offered.
    val state    = invoiceStateOrNull(invoice)
    val overdue  = invoiceIsOverdue(invoice, todayKey)
    // Like overdue, a display refinement of OPEN and never its own state, so it
    // changes the pill and the copy and leaves the action set alone. That is
    // what keeps "Record payment" available for collecting the rest.
    val partPaid = invoicePartPaid(invoice)
    val actions  = invoiceActionsFor(state)

    // ── Header status bar (accent-tinted full-width) ────────────────────────────
    item {
        InvoiceHeaderBar(invoice = invoice, state = state, overdue = overdue, partPaid = partPaid != null)
    }

    // ── Amount stat row ─────────────────────────────────────────────────────────
    item {
        val (statusTone, _, _) = statusTriple(state, invoice.status, overdue, partPaid != null)
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
                label = if (partPaid != null) "Still owed" else "Amount due",
                value = formatMoney(invoice.amountDue),
                trend = when {
                    // Names both figures: a part-paid invoice that only showed
                    // what is left would hide the payment already collected.
                    partPaid != null -> "${formatCentsUsd(partPaid.paidCents)} of ${formatMoney(invoice.total)} paid"
                    overdue -> "past due ${invoice.dueDate.trim().take(10)}"
                    state == InvoiceState.OPEN ->
                        "due ${invoice.dueDate.trim().take(10).ifBlank { "soon" }}"
                    state == InvoiceState.PAID -> "paid in full"
                    state == InvoiceState.DRAFT -> "not sent yet"
                    state == InvoiceState.QUOTE -> "quoted, not billed"
                    state == InvoiceState.CANCELLED -> "cancelled"
                    state == InvoiceState.CREDIT -> "credit owed to the household"
                    state == InvoiceState.REDEEMED -> "credit redeemed"
                    state == InvoiceState.ZERO -> "nothing billed"
                    // No recognizable stamp: the raw stored word, not a guess.
                    else -> invoice.status.trim().ifBlank { "no status on record" }
                },
                tone     = statusTone,
                feature  = true,
                modifier = Modifier.weight(1f),
            )
        }
    }

    // Header actions, gated by the shared action set. Generate receipt is a PAID-only
    // action and Send reminder an OPEN-only one, so a paid invoice no longer offers a
    // reminder the server would reject, and a quote, a credit, or a $0 row no longer
    // offers a receipt for a bill that was never collected.
    //
    // Download PDF is deliberately UNGATED: it reads the invoice, it does not act on
    // it or reach the household, so every state can produce one.
    item {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (InvoiceAction.GENERATE_RECEIPT in actions) {
                GhostButton(
                    label   = if (generatingReceipt) "Generating…" else "Generate receipt",
                    onClick = onGenerateReceipt,
                    enabled = !generatingReceipt,
                )
            }
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
            if (InvoiceAction.SEND_REMINDER in actions) {
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
            // Archive is deliberately NOT part of `actions`. That matrix answers
            // "what can be done about the money", and archiving is orthogonal to
            // it: an invoice in any state can be taken out of the working list.
            // Folding it in would have meant appending it to all seven branches.
            GhostButton(
                label   = if (com.tribetails.auntieos.domain.invoiceIsArchived(invoice)) "Restore" else "Archive",
                onClick = onArchive,
                enabled = !archiving,
            )
        }
    }

    // An archived invoice says what that does and does NOT mean, rather than
    // simply vanishing from the list with no explanation on its own detail page.
    if (com.tribetails.auntieos.domain.invoiceIsArchived(invoice)) {
        item {
            AuntieBanner(
                tone  = AuntieBannerTone.Info,
                title = "Archived",
            ) {
                Text(
                    text = "This invoice is out of the working list and out of the revenue and outstanding " +
                        "totals. It has not been deleted or cancelled, and the household can still see it " +
                        "and still pay it.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }

    // Draft review-and-send: only on a DRAFT invoice, wired to the
    // reviewAndSendDraftInvoice callable. Fail-loud if the draft is incomplete:
    // the action stays present and the VM surfaces the server's precondition.
    if (InvoiceAction.REVIEW_AND_SEND in actions) {
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

    // ── Line items ──────────────────────────────────────────────────────────────
    // Read-only in Task 5.1 by explicit ruling: Android renders what the web
    // wrote. The editor and the un-invoiced-visits picker are task 5.1a.
    item {
        val lines = com.tribetails.auntieos.domain.invoiceLineItems(invoice)
        DenPanel(title = "Line items") {
            Column {
                when {
                    // ABSENT, not empty. Every invoice created before Task 5.1 is
                    // in this state, so it is the common branch. It gets a
                    // SENTENCE rather than an empty table: a heading over no rows
                    // reads as "nothing was billed", which is a different and far
                    // worse claim than "nobody has broken this invoice down".
                    lines == null -> EmptyHint("No itemized breakdown. This invoice's total was entered directly.")
                    lines.isEmpty() -> EmptyHint("Itemized as billing nothing: there is a breakdown, and it is empty.")
                    else -> {
                        lines.forEachIndexed { idx, line ->
                            InvoiceLineItemRow(line, showDivider = idx > 0)
                        }
                        InvoiceLineTotalsRows(lines, invoice.invoiceDiscountCents)
                    }
                }
            }
        }
    }

    // ── Lines-versus-total disagreement ─────────────────────────────────────────
    // NOT decoration. `firestore.rules:219-226` grants `allow update: if
    // isAuntie()` over the whole invoices collection, and `postInvoiceEvent`
    // merges an arbitrary payload; both bypass every callable that would have
    // kept the stored total in step with the lines. The banner NAMES BOTH
    // FIGURES and RECONCILES NEITHER: picking a winner, or quietly showing the
    // derived figure in place of the stored one, would hide the drift from the
    // only person who can resolve it.
    com.tribetails.auntieos.domain.invoiceTotalDisagreement(invoice)?.let { drift ->
        item {
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "This invoice disagrees with itself",
            ) {
                Text(
                    text = "The line items add up to ${com.tribetails.auntieos.domain.formatCents(drift.derivedCents)}, " +
                        "but the total stored on the invoice says ${com.tribetails.auntieos.domain.formatCents(drift.storedCents)}. " +
                        "Nothing has been changed to make them match, and nothing will be. The household is " +
                        "billed the stored figure. Re-saving the line items in the web admin will recompute " +
                        "the stored total from them, if the lines are the version you want to keep.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }

    // ── Amounts panel ─────────────────────────────────────────────────────────────
    item {
        val amountTone =
            if (state == InvoiceState.PAID) KeyValueStyle.AccentSuccess else KeyValueStyle.AccentError
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
            // Record payment is Android's "Mark paid": the same transition, through
            // the dialog that also writes the Payment.invoiceId audit link. Gated to
            // the states that can actually take a payment, so a paid, cancelled, or
            // quoted invoice cannot collect twice or collect early. Already-recorded
            // payments still render below in every state.
            trailing = {
                if (InvoiceAction.RECORD_PAYMENT in actions) {
                    GhostButton(label = "Record payment", onClick = onRecordPayment)
                }
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!invoice.paymentsHistory.isNullOrBlank()) {
                    Text(
                        invoice.paymentsHistory.orEmpty(),
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

                    invoice.paymentsHistory.isNullOrBlank() ->
                        EmptyHint(
                            if (InvoiceAction.RECORD_PAYMENT in actions) {
                                "No payment recorded against this invoice yet. Use Record payment to log one."
                            } else {
                                "No payment recorded against this invoice."
                            },
                        )
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
private fun InvoiceHeaderBar(invoice: Invoice, state: InvoiceState?, overdue: Boolean, partPaid: Boolean = false) {
    val c = AuntieTheme.colors
    val (statusTone, statusText, statusIcon) = statusTriple(state, invoice.status, overdue, partPaid)
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

/**
 * One billed line, read-only. Follows `LinkedSessionRow` below, including its
 * top-hairline-between-rows treatment.
 *
 * THE AMOUNT IS DERIVED, not read off the document. There is no stored per-line
 * amount, and computing it here through the shared `domain/InvoiceLineItems.kt`
 * is what makes the lines shown and the total shown obey one rule.
 */
@Composable
private fun InvoiceLineItemRow(
    line: com.tribetails.auntieos.data.model.InvoiceLineItem,
    showDivider: Boolean,
) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
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
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                // A line whose description was lost says so, rather than
                // rendering blank, which reads as a display bug and not as data.
                line.description.ifBlank { "no description" },
                style = AuntieTheme.typography.bodySmall,
                color = if (line.description.isBlank()) c.textDim else c.textPrimary,
            )
            Text(
                buildString {
                    append(com.tribetails.auntieos.domain.formatQty(line.qty))
                    append(" x ")
                    append(com.tribetails.auntieos.domain.formatCents(line.unitCents))
                    if (line.discountCents > 0) {
                        // Printed rather than folded silently into the amount, so
                        // the operator can see what was taken off.
                        append(", less ")
                        append(com.tribetails.auntieos.domain.formatCents(line.discountCents))
                    }
                },
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
            )
        }
        Text(
            com.tribetails.auntieos.domain.formatCents(com.tribetails.auntieos.domain.lineAmountCents(line)),
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
    }
}

/** Subtotal, optional whole-invoice discount, and the total the lines come to. */
@Composable
private fun InvoiceLineTotalsRows(
    lines: List<com.tribetails.auntieos.data.model.InvoiceLineItem>,
    invoiceDiscountCents: Long,
) {
    val subtotal = com.tribetails.auntieos.domain.invoiceSubtotalCents(lines)
    AuntieKeyValueRow(
        label = "Subtotal",
        value = com.tribetails.auntieos.domain.formatCents(subtotal),
        valueMono = true,
    )
    if (invoiceDiscountCents > 0) {
        AuntieKeyValueRow(
            label = "Invoice discount",
            value = "-" + com.tribetails.auntieos.domain.formatCents(invoiceDiscountCents),
            valueMono = true,
        )
    }
    AuntieKeyValueRow(
        label = "Total from these lines",
        value = com.tribetails.auntieos.domain.formatCents(subtotal - invoiceDiscountCents),
        valueMono = true,
        showDivider = false,
    )
}

@Composable
private fun LinkedSessionRow(session: KinCareSession, showDivider: Boolean) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
    val dateLabel = session.completedAt.orEmpty().take(10).ifBlank { session.startTime.take(10) }.ifBlank { "-" }
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
 *
 * The amount is PREFILLED with the outstanding balance and editable, so the
 * common case is one tap and a partial is one edit away. The server decides what
 * the payment means (see [InvoiceDetailViewModel.recordPayment]); the copy below
 * says so, because an operator entering less than the balance needs to know
 * before they submit that the invoice will stay open rather than be closed out.
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
            Text(
                text  = "A payment smaller than the balance leaves this invoice open for the rest.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
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
    /**
     * Ids the SERVER says are billable: completed, claimed by no invoice, inside
     * the window. `available` is every session for the household with no
     * predicate, so without this a visit already billed elsewhere and one that
     * has not happened yet are indistinguishable from a real candidate.
     */
    billableIds: Set<String> = emptySet(),
    /** Billable, but the rate card could not price it. Not a price of zero. */
    unpricedIds: Set<String> = emptySet(),
    rateCardLoaded: Boolean = true,
    /** Billable work no date window can reach. Naming it is the only way it is seen. */
    unplaceableIds: List<String> = emptyList(),
    billableTruncated: Boolean = false,
    billableLoading: Boolean = false,
    /** The billable check failed. "None" and "we could not tell" must not look alike. */
    billableError: String? = null,
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
        // What the operator needs BEFORE picking, in the order it changes a
        // decision: can we tell which are billable, are any priced at nothing,
        // is work missing from the list entirely, is the list even complete.
        when {
            billableLoading -> Text(
                text  = "Checking which visits are still un-billed\u2026",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            billableError != null -> Text(
                // Fail loud. Silence here reads as "nothing is billable", which
                // is the same screen as "everything is already billed".
                text  = "Could not check which visits are billable: $billableError. " +
                    "Every session below is shown unchecked, so confirm before saving.",
                style = AuntieTheme.typography.bodySmall,
                color = c.warning,
            )
            !rateCardLoaded -> Text(
                text  = "There is no service rate card, so nothing below could be priced automatically. " +
                    "Anything you link still needs a price on the invoice.",
                style = AuntieTheme.typography.bodySmall,
                color = c.warning,
            )
            unpricedIds.isNotEmpty() -> Text(
                text  = "${unpricedIds.size} of these has no rate on the card, so it will need a price " +
                    "typed in. It is never billed at zero.",
                style = AuntieTheme.typography.bodySmall,
                color = c.warning,
            )
        }
        if (unplaceableIds.isNotEmpty()) {
            // Widening the dates cannot surface these, so the copy says what to
            // fix rather than sending the operator back to the window.
            Text(
                text  = "${unplaceableIds.size} completed visit(s) for this household have no start time, " +
                    "so no date range can find them and they cannot be billed here. Fix the start time on " +
                    "the visit itself. Visit id(s): ${unplaceableIds.joinToString(", ")}",
                style = AuntieTheme.typography.bodySmall,
                color = c.warning,
            )
        }
        if (billableTruncated) {
            Text(
                text  = "The billable check hit the server's page limit, so there may be un-billed visits " +
                    "it did not return.",
                style = AuntieTheme.typography.bodySmall,
                color = c.warning,
            )
        }
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
                    val dateLabel = session.completedAt.orEmpty().take(10)
                        .ifBlank { session.startTime.take(10) }
                        .ifBlank { "-" }
                    // A session the server did not call billable is either
                    // already on another invoice or not finished. It stays
                    // tappable, because a session ALREADY linked to this
                    // invoice is excluded by the callable too and has to remain
                    // unlinkable, but it says what it is rather than looking
                    // like an ordinary candidate.
                    val linkedHere = session.id in selectedIds
                    val billable = session.id in billableIds
                    val suffix = when {
                        billableLoading || billableError != null -> ""
                        billable && session.id in unpricedIds -> " · needs a price"
                        billable -> ""
                        linkedHere -> " · on this invoice"
                        else -> " · not billable"
                    }
                    val chipLabel = "${session.serviceType.ifBlank { "Session" }} · $dateLabel$suffix"
                    AuntieChip(
                        label    = chipLabel,
                        selected = linkedHere,
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

/**
 * Resolves the STORED [InvoiceState] (plus the overdue refinement) to its
 * (tone, label, leadingIcon) triple. Pure; unit-tested.
 *
 * This screen used to own a private three-member `InvoiceStatus` enum and an
 * `invoiceStatusFor` resolver whose first line was `amountDue <= 0 -> PAID`,
 * so a draft, a quote, and an unredeemed credit all rendered a confident PAID
 * pill while the Den list showed them correctly. Both are gone, and so is the
 * classifier that replaced them: the state is the server's persisted stamp,
 * decoded by domain/InvoiceActions.kt, the same read the list makes.
 *
 * [rawStatus] is rendered VERBATIM (uppercased for the pill) when the stamp is
 * null - absent or outside the eight-word vocabulary. Showing the doc's own
 * word for itself is the fail-soft ruling; deriving a nicer label from the
 * money would resurrect the deleted classifier.
 */
private fun statusTriple(
    state: InvoiceState?,
    rawStatus: String,
    overdue: Boolean,
    partPaid: Boolean = false,
): Triple<AuntieStatusTone, String, androidx.compose.ui.graphics.vector.ImageVector> {
    // Overdue outranks the plain OUTSTANDING pill visually. It is a refinement
    // of OPEN, never its own state, so it cannot apply to anything else.
    if (overdue) return Triple(AuntieStatusTone.Error, "OVERDUE", Lucide.CircleAlert)
    // PART PAID is the same kind of refinement, ranked below overdue: an overdue
    // invoice that is also part-paid is, first, overdue. It is deliberately not
    // the Success tone a settled invoice gets, because it is not settled.
    if (partPaid) return Triple(AuntieStatusTone.Purple, "PART PAID", Lucide.Clock)
    return when (state) {
        InvoiceState.PAID      -> Triple(AuntieStatusTone.Success, "PAID", Lucide.CircleCheckBig)
        InvoiceState.OPEN      -> Triple(AuntieStatusTone.Warning, "OUTSTANDING", Lucide.Clock)
        InvoiceState.DRAFT     -> Triple(AuntieStatusTone.Muted, "DRAFT", Lucide.Clock)
        InvoiceState.QUOTE     -> Triple(AuntieStatusTone.Purple, "QUOTE", Lucide.FileText)
        InvoiceState.CANCELLED -> Triple(AuntieStatusTone.Muted, "CANCELLED", Lucide.X)
        InvoiceState.CREDIT    -> Triple(AuntieStatusTone.Teal, "CREDIT", Lucide.CircleAlert)
        InvoiceState.REDEEMED  -> Triple(AuntieStatusTone.Muted, "REDEEMED", Lucide.CircleCheckBig)
        InvoiceState.ZERO      -> Triple(AuntieStatusTone.Muted, "ZERO", Lucide.FileText)
        null                   -> Triple(
            AuntieStatusTone.Muted,
            rawStatus.trim().uppercase().ifBlank { "NO STATUS" },
            Lucide.CircleAlert,
        )
    }
}

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
