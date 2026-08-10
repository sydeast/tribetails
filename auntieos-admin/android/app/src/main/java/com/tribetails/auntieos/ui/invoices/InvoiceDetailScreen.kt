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
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.domain.InvoiceAction
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.invoiceActionsFor
import com.tribetails.auntieos.domain.invoiceIsOverdue
import com.tribetails.auntieos.domain.formatCentsUsd
import com.tribetails.auntieos.domain.dollarsToCents
import com.tribetails.auntieos.domain.parseOptionalMoney
import com.tribetails.auntieos.domain.unappliedCents
import com.tribetails.auntieos.domain.invoicePartPaid
import com.tribetails.auntieos.domain.InvoiceDisputeDeadline
import com.tribetails.auntieos.domain.InvoiceDisputeFundsState
import com.tribetails.auntieos.domain.InvoiceDisputeInfo
import com.tribetails.auntieos.domain.formatDisputeDeadline
import com.tribetails.auntieos.domain.invoiceDisputeDeadline
import com.tribetails.auntieos.domain.invoiceDisputeOrNull
import com.tribetails.auntieos.domain.invoiceDisputeReasonGloss
import com.tribetails.auntieos.domain.invoiceDisputeTimeLeft
import com.tribetails.auntieos.domain.freeTextDateLabel
import com.tribetails.auntieos.domain.invoiceStateOrNull
import com.tribetails.auntieos.domain.ledgerCaveats
import com.tribetails.auntieos.domain.ledgerRowAppliedLabel
import com.tribetails.auntieos.domain.ledgerRowBalanceCents
import com.tribetails.auntieos.domain.ledgerRowDateLabel
import com.tribetails.auntieos.domain.ledgerRowFeeLabel
import com.tribetails.auntieos.domain.ledgerRowMethodLabel
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCheckbox
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
                        paymentsLoading   = uiState.paymentsLoading,
                        paymentsError     = uiState.paymentsError,
                        generatingReceipt = uiState.generatingReceipt,
                        sendingReminder   = uiState.sendingReminder,
                        sendingDraft      = uiState.sendingDraft,
                        generatingPdf     = uiState.generatingPdf,
                        businessSettings  = uiState.businessSettings,
                        archiving         = uiState.archiving,
                        onOpenEdit        = { viewModel.openEditMode() },
                        onRecordPayment   = { viewModel.openRecordPayment() },
                        onRetryPayments   = { viewModel.retryPayments() },
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
    linkedPayments: List<GetInvoiceLedgerResultLedgerPayment>,
    clientPayments: List<GetInvoiceLedgerResultLedgerPayment>,
    paymentsLoading: Boolean,
    paymentsError: String?,
    generatingReceipt: Boolean,
    sendingReminder: Boolean,
    sendingDraft: Boolean,
    generatingPdf: Boolean,
    businessSettings: com.tribetails.auntieos.data.model.BusinessSettings?,
    archiving: Boolean,
    onOpenEdit: () -> Unit,
    onRecordPayment: () -> Unit,
    onRetryPayments: () -> Unit,
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
                    // `invoices.dueDate` is free text, same family as the
                    // ledger's payment date: see [freeTextDateLabel] for why
                    // ten characters of it is a different day, not a shorter
                    // one. The `past due` branch could not be reached by free
                    // text - `invoiceIsOverdue` declines anything it cannot
                    // read as ISO - but it printed a raw instant, and both
                    // branches now say the same day the record says.
                    overdue -> "past due ${freeTextDateLabel(invoice.dueDate)}"
                    state == InvoiceState.OPEN ->
                        "due ${freeTextDateLabel(invoice.dueDate).ifBlank { "soon" }}"
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

    // ── Chargeback ─────────────────────────────────────────────────────────────
    // Straight under the two money cards, because it is the fact that decides
    // whether those two figures still describe money the business has.
    val dispute = invoiceDisputeOrNull(invoice)
    if (dispute != null) {
        item { InvoiceDisputeBanner(dispute = dispute) }
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
                    // NOTHING READ IS NOT NOTHING THERE, and these two branches
                    // exist so the panel cannot confuse them. Both lists default
                    // to empty, so before this the panel announced "no payment
                    // recorded against this invoice" while the read was still in
                    // flight, and went on announcing it after the read failed,
                    // with only a toast, which fades, to say otherwise.
                    paymentsError != null -> AuntieBanner(
                        tone  = AuntieBannerTone.Error,
                        title = "Couldn't load this invoice's payments",
                        icon  = Lucide.CircleAlert,
                        body  = {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                // The server's own words, never reworded: they are
                                // what tells the operator whether to retry or to
                                // call someone.
                                Text(
                                    paymentsError,
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                                Text(
                                    "Nothing is listed here because the read failed, not because " +
                                        "nothing was collected. The invoice's own figures above are " +
                                        "unaffected.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                                GhostButton(label = "Try again", onClick = onRetryPayments)
                            }
                        },
                    )

                    paymentsLoading -> EmptyHint("Loading this invoice's payments…")

                    // Confident per-invoice join via the populated Payment.invoiceId.
                    linkedPayments.isNotEmpty() ->
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                                linkedPayments.forEachIndexed { idx, p ->
                                    PaymentRow(p, showDivider = idx > 0)
                                }
                            }
                            LedgerCaveatBanner(linkedPayments)
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
                        // The same caveats, because it is the same kind of record.
                        LedgerCaveatBanner(clientPayments)
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

/**
 * The banner tone, from the one flag that decides it.
 *
 * `internal` rather than private, and a function rather than an inline `if`, so
 * the alarm-versus-history decision is assertable: the rendered colour is not
 * readable through Compose's semantics tree, so a test can only reach this
 * choice by calling it.
 */
internal fun invoiceDisputeTone(open: Boolean): AuntieBannerTone =
    if (open) AuntieBannerTone.Error else AuntieBannerTone.Info

/**
 * THE CHARGEBACK PANEL: the only thing on this screen that can contradict the
 * green PAID pill in the header bar above it.
 *
 * A dispute deliberately does not un-pay the invoice — flipping it back to
 * outstanding would restart the reminder cron against a household over their own
 * bank's action, and writing a reversing payment row would invent a repayment
 * nobody made (functions/src/billing/stripeDispute.ts). The cost of that correct
 * decision is that a clawed-back invoice looks settled everywhere. This panel is
 * where that debt is paid back to the operator.
 *
 * TONE IS DECIDED BY ONE FLAG AND ONE ONLY, [InvoiceDisputeInfo.open]. Nothing
 * clears `disputeStatus`, so an invoice disputed once carries it forever; keying
 * the alarm off "there is a status" would light up every invoice that was ever
 * contested and won, permanently. A won dispute is history and reads as history.
 *
 * NO FIGURE APPEARS HERE THAT STRIPE DID NOT SEND. The disputed amount prints
 * when the event carried one and is named in words when it did not, never as
 * $0.00. The actual debit — disputed amount plus Stripe's dispute fee — is
 * described but never computed, because the fee is not on the object and a sum
 * we cannot source is a lie with a dollar sign on it.
 *
 * There is no dismiss, no clear and no resolve control, by design.
 *
 * Mirrors the web `InvoiceDisputeBanner` in `src/components/InvoiceDetail.tsx`.
 */
@Composable
private fun InvoiceDisputeBanner(dispute: InvoiceDisputeInfo) {
    val c = AuntieTheme.colors
    val tone = invoiceDisputeTone(dispute.open)
    val body = AuntieTheme.typography.bodyMedium

    val amountSentence = if (dispute.amountCents != null) {
        "The bank is disputing ${formatCentsUsd(dispute.amountCents)}."
    } else {
        "The dispute event did not carry an amount, so how much is contested is not stated here."
    }
    val idSentence = if (dispute.disputeId != null) " Stripe dispute ${dispute.disputeId}." else ""

    // WHY THE CARDHOLDER IS DISPUTING. The raw Stripe token is always shown and
    // plain English joins it when this build has a gloss for that category. A
    // token with no gloss stands alone: it is not relabelled, not called
    // "Unknown", and it does not take the banner down with it. `reason` is a
    // plain String in the pinned SDK and Stripe ships new categories on its own
    // schedule, so an unfamiliar one is the expected case, not the broken one.
    //
    // Rendered on the closed-history banner too. Why a dispute happened is
    // worth keeping once it is over; the clock is not.
    val reasonSentence = dispute.reason?.let { reason ->
        val gloss = invoiceDisputeReasonGloss(reason)
        if (gloss != null) {
            "The bank filed it as $reason: $gloss."
        } else {
            "The bank filed it as $reason. This build has no plain-English description for that " +
                "category, which means Stripe has added one since it shipped; the Stripe " +
                "dashboard has Stripe's own wording for it."
        }
    }

    // BY WHEN THE OPERATOR MUST ACT — or an honest account of why there is no
    // clock. Null unless the dispute is answerable, so a settled dispute cannot
    // show a countdown to a date that has stopped meaning anything. See
    // `invoiceDisputeDeadline` for the gate and for why a passed deadline is
    // stated as a closed window rather than as a verdict or a negative number.
    val deadlineSentence = when (val d = invoiceDisputeDeadline(dispute, System.currentTimeMillis())) {
        is InvoiceDisputeDeadline.None -> null
        is InvoiceDisputeDeadline.Unstated ->
            "Stripe has stated no response deadline for this dispute. That can mean the issuing " +
                "bank allows no response to it at all, so there is no countdown to show and none " +
                "is being guessed at. Open the dispute in the Stripe dashboard to see what it " +
                "will accept."
        is InvoiceDisputeDeadline.Passed ->
            "The window to respond closed on ${formatDisputeDeadline(d.dueByMs)}. This screen " +
                "still shows the dispute as awaiting a response, and that reading comes from " +
                "Stripe by webhook and can lag behind Stripe itself, so what happened after the " +
                "window shut is not something this screen knows. Open the dispute in the Stripe " +
                "dashboard before assuming it is either still answerable or already settled."
        is InvoiceDisputeDeadline.Due ->
            "Respond by ${formatDisputeDeadline(d.dueByMs)}: " +
                "${invoiceDisputeTimeLeft(d.msRemaining)}. A chargeback nobody answers in time " +
                "is lost by default, so this date decides the money on its own."
    }

    AuntieBanner(
        tone = tone,
        title = if (dispute.open) "This payment is being taken back" else "Dispute won",
        icon = if (dispute.open) Lucide.CircleAlert else Lucide.CircleCheckBig,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!dispute.open) {
                Text(
                    text = "This payment was disputed and the dispute was resolved in your favor. " +
                        "Nothing was undone, because nothing needed undoing: the invoice was never " +
                        "un-paid while the contest ran. $amountSentence",
                    style = body,
                    color = c.textPrimary,
                )
                if (reasonSentence != null) {
                    Text(text = reasonSentence, style = body, color = c.textPrimary)
                }
                Text(
                    text = when (dispute.fundsState) {
                        InvoiceDisputeFundsState.WITHDRAWN ->
                            "The money has not been reported back in the Stripe balance yet. Stripe " +
                                "reinstates funds after the ruling rather than at the moment of it, so " +
                                "a gap here is ordinary."
                        InvoiceDisputeFundsState.REINSTATED ->
                            "Stripe has reported the money back in the balance."
                        null -> "Stripe has reported no movement of the balance either way."
                    } + " This stays on record because the dispute genuinely happened; it is not " +
                        "something to clear.$idSentence",
                    style = body,
                    color = c.textDim,
                )
                return@AuntieBanner
            }

            Text(
                text = if (dispute.status != null) {
                    "The cardholder's bank has raised a chargeback and Stripe puts it at " +
                        "${dispute.status}. $amountSentence$idSentence"
                } else {
                    "The cardholder's bank has raised a chargeback. Stripe has not said where the " +
                        "dispute stands, only that the money moved. $amountSentence$idSentence"
                },
                style = body,
                color = c.textPrimary,
            )
            if (reasonSentence != null) {
                Text(text = reasonSentence, style = body, color = c.textPrimary)
            }
            if (deadlineSentence != null) {
                Text(text = deadlineSentence, style = body, color = c.textPrimary)
            }
            Text(
                text = when (dispute.fundsState) {
                    InvoiceDisputeFundsState.WITHDRAWN ->
                        "The money has already been pulled out of the Stripe balance. What actually " +
                            "left is the disputed amount plus Stripe's dispute fee, and the fee is not " +
                            "on the record here, so read the real debit in the Stripe balance report " +
                            "rather than from this screen."
                    InvoiceDisputeFundsState.REINSTATED ->
                        "Stripe has reported the money back in the balance, while the contest itself " +
                            "is still open."
                    null ->
                        "Stripe has not yet reported the balance moving. It usually moves before the " +
                            "dispute closes, so treat this as not-yet-seen rather than as money that " +
                            "is safe."
                },
                style = body,
                color = c.textPrimary,
            )
            Text(
                text = "This invoice still reads paid and still shows nothing due, on purpose. " +
                    "Un-paying it would start sending the household overdue reminders over something " +
                    "their bank did, and recording a reversal would invent a repayment that never " +
                    "happened. Where contested money ends up is your call to make, not this screen's.",
                style = body,
                color = c.textDim,
            )
        }
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

/**
 * One row of the invoice's display ledger, as `getInvoiceLedger` returned it.
 *
 * TWO THINGS CHANGED HERE AND BOTH ARE THE POINT.
 *
 * The figure is `amountCents`, an integer the SERVER resolved, rendered by
 * [formatCentsUsd]. It used to be `payment.amount`, a `Double` read straight out
 * of the root `payments` collection whose unit depends on an `amountSource`
 * field the Kotlin `Payment` model does not carry — so a $137.50 Stripe payment,
 * stored by `stripeWebhook.ts` as Stripe's own `13750` cents, printed as
 * $13,750.00. There is no ambiguous number left on this path to misread.
 *
 * And the tip is no longer ADDED to it. `amount` is documented on both sides as
 * "the whole sum collected from the client, the GROSS tip included", so
 * `amount + tip` counted the gratuity twice on every tipped row — a second,
 * quieter money bug on the same line. The web ledger has always rendered
 * `amountCents` alone (`InvoiceLedger.tsx`); this row now agrees with it.
 *
 * A THIRD THING, AND IT IS THE SAME KIND OF LIE. `amountResolved: false` means
 * the server could not interpret the stored figure at all: an `unresolved`
 * Stripe event, or an `amount` that is not a usable number. `amountCents` is 0
 * on such a row because 0 is the floor the schema allows, NOT because nothing
 * was collected — and this row printed it as "$0.00" in the same green it uses
 * for money that really arrived. It now says so instead, in the dim colour the
 * screen already uses for what is absent, and the web table's Amount cell says
 * the same words.
 *
 * ── A FOURTH THING: THE OTHER FOUR FIGURES ────────────────────────────────
 *
 * `getInvoiceLedger` has always answered with `appliedCents`, `tipCents`,
 * `feeCents` and `unappliedCents`, Android has always decoded them, and this row
 * threw all four away. So the phone showed one number with nothing to check it
 * against. That is precisely how invoice #1029 sat at Amount $137.50 with
 * $2.71 unaccounted for and nobody could see it. The row now reads across:
 *
 *     amount = applied + tipGross + balance,   fee taken out of the tip
 *
 * ── WHY A STACK AND NOT A TABLE, AN EXPANDER, OR A SHEET ──────────────────
 *
 * Web renders eight columns. A phone cannot, and the three obvious ways out are
 * all worse here:
 *
 *  - AN EXPANDER OR A DETAIL SHEET puts the breakdown one tap away, which makes
 *    the DEFAULT state of the row identical to the broken one this change
 *    exists to fix. The operator could not see #1029 fail to reconcile because
 *    the figures were not on screen; hiding them behind a chevron reproduces
 *    that exactly, for everyone who does not tap. Money that has to be asked for
 *    does not get checked.
 *  - A SIDEWAYS TABLE would be a new idea on this screen. Nothing in `ui/`
 *    scrolls money horizontally.
 *
 * So this composes the two patterns the app already uses for dense money, both
 * of them on THIS screen: the two-tier summary row (`InvoiceLineItemRow`, which
 * puts "3 x $50.00, less $10.00" under the description) and the label/value
 * money stack (`InvoiceLineTotalsRows` and the Amounts panel, both
 * [AuntieKeyValueRow]). The summary stays exactly as it was; the breakdown is
 * the web table's columns turned ninety degrees underneath it.
 *
 * [LedgerFactRow] rather than [AuntieKeyValueRow] itself, for one measured
 * reason: that component is a 52dp screen-level row, and four of them per
 * payment is over 200dp, a single payment filling a phone. This keeps its
 * language (dim uppercase mono label left, mono figure right) at a quarter of
 * the height.
 *
 * ALL FOUR LABELS ALWAYS RENDER. A cell that vanishes when its value is absent
 * makes "no fee was charged" and "the fee was never recorded" look the same,
 * and telling those apart is the entire reason the fee exists.
 */
@Composable
private fun PaymentRow(payment: GetInvoiceLedgerResultLedgerPayment, showDivider: Boolean) {
    val c = AuntieTheme.colors
    // Both of these were assumptions about a field the server documents as free
    // text. See [ledgerRowDateLabel] for what ten characters of "February 17,
    // 2026" reads as, and why the fix is not a bare passthrough.
    val dateLabel = ledgerRowDateLabel(payment)
    val method = ledgerRowMethodLabel(payment)
    val appliedTo = ledgerRowAppliedLabel(payment)
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
    Column(
        modifier = Modifier
            .fillMaxWidth()
            // The top rule between payments, the same treatment
            // `LinkedSessionRow` gives its list. `showDivider` has been a
            // parameter of this row since it shipped and was never drawn, which
            // did not show when a payment was one line; now that it is five, two
            // payments run into each other without it.
            .drawBehind {
                if (showDivider) {
                    val h = hairline.toPx()
                    drawLine(
                        color = ruleColor,
                        start = Offset(0f, h / 2f),
                        end = Offset(size.width, h / 2f),
                        strokeWidth = h,
                    )
                }
            }
            .padding(top = if (showDivider) 14.dp else 9.dp, bottom = 9.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(method, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                Text(dateLabel, style = AuntieTheme.typography.labelSmall, color = c.textDim)
            }
            if (payment.amountResolved) {
                Text(
                    formatCentsUsd(payment.amountCents),
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.success,
                )
            } else {
                Text(
                    "could not be read",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }

        Column(modifier = Modifier.padding(top = 6.dp)) {
            LedgerFactRow(
                label = "Applied to",
                // Never "$0.00 applied". A payment that touched no balance is a
                // different fact from one that applied nothing to it.
                value = if (appliedTo == "") "not applied" else formatCentsUsd(payment.appliedCents),
                dim = appliedTo == "",
                // The bill the money went to, beside how much of it went there.
                note = if (appliedTo == "") null else appliedTo,
            )
            LedgerFactRow(
                label = "Tip",
                value = formatCentsUsd(payment.tipCents),
                // The tax-relevant fact, said once on every row that has one:
                // the stored tip is the GROSS. The net is derived and never
                // stored, so nothing can lose the deductible half again.
                note = if (payment.tipCents > 0L && payment.tipBasis == "gross") "gross" else null,
            )
            LedgerFactRow(
                label = "Fee",
                value = ledgerRowFeeLabel(payment),
                // Dim ONLY for the stand-in. The fee is read from its own stored
                // field, so it stays a full-strength reading even on a row whose
                // amount could not be resolved. Muting it there would suggest
                // the unreadable amount had infected it.
                dim = payment.feeCents == 0L && !payment.reconciles,
            )
            LedgerFactRow(
                label = "Balance",
                // THE BALANCE IS NOT SHOWN ON A ROW WHOSE AMOUNT COULD NOT BE
                // READ. The server works it out as amount - applied - tip, and
                // on such a row the amount it used was the schema's floor of 0
                // rather than a reading, so the figure that falls out is
                // arithmetic on a non-number. "-$127.50" would look like a real
                // over-application. The caveat below names the row.
                value = if (payment.amountResolved) {
                    formatCentsUsd(ledgerRowBalanceCents(payment))
                } else {
                    "could not be read"
                },
                dim = !payment.amountResolved,
                // Where the leftover went. Auto-apply moves it into the
                // household's account credit for a future invoice; without it
                // the money is simply sitting unapplied.
                note = if (payment.amountResolved && payment.unappliedCents > 0L && payment.autoApply) {
                    "held as credit"
                } else {
                    null
                },
                showDivider = false,
            )
        }
    }
}

/**
 * One line of a payment's breakdown: dim uppercase label left, figure right,
 * with an optional short [note] beside the figure for the thing the number
 * alone does not say ("gross", "held as credit", which invoice).
 *
 * Deliberately the visual language of [AuntieKeyValueRow] at a quarter of its
 * height. See the note on [PaymentRow] for why it is not that component.
 * [dim] renders the figure in the muted tone the screen already uses for what is
 * absent or unverified, so an operator scanning a column can tell a reading from
 * a stand-in without reading the words.
 */
@Composable
private fun LedgerFactRow(
    label: String,
    value: String,
    dim: Boolean = false,
    note: String? = null,
    showDivider: Boolean = true,
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
                    val y = size.height - (h / 2f)
                    drawLine(
                        color = ruleColor,
                        start = Offset(0f, y),
                        end = Offset(size.width, y),
                        strokeWidth = h,
                    )
                }
            }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (note != null) {
                Text(note, style = AuntieTheme.typography.labelSmall, color = c.textDim)
            }
            Text(
                value,
                style = AuntieTheme.typography.mono,
                color = if (dim) c.textDim else c.textPrimary,
            )
        }
    }
}

/**
 * The rows that CANNOT be made to add up, named once each rather than left as
 * arithmetic that silently fails.
 *
 * Fed from BOTH lists, never just the linked one. Android shows a household
 * fallback the web ledger has no equivalent for, and a migrated row in it is
 * every bit as unreadable as a migrated row in the other.
 */
@Composable
private fun LedgerCaveatBanner(rows: List<GetInvoiceLedgerResultLedgerPayment>) {
    val caveats = ledgerCaveats(rows)
    if (caveats.isEmpty()) return
    AuntieBanner(
        tone = AuntieBannerTone.Warning,
        title = "Some of these rows cannot be reconciled",
        icon = Lucide.CircleAlert,
        body = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                caveats.forEach { caveat ->
                    Text(
                        caveat,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }
                Text(
                    "Nothing has been guessed to make them balance. Payments recorded from now on " +
                        "store the gross tip and the processor fee separately, so they reconcile " +
                        "on their own.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        },
    )
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
    // ── The fee tranche, 2026-08-04 ──────────────────────────────────────────
    // Blank, not "0.00". An empty tip box means no tip was entered; a prefilled
    // zero is a claim that there was none, and she would have to clear it to
    // type one.
    var tip       by remember(invoice.id) { mutableStateOf("") }
    var fee       by remember(invoice.id) { mutableStateOf("") }
    var total     by remember(invoice.id) { mutableStateOf("") }
    var autoApply by remember(invoice.id) { mutableStateOf(false) }
    // OFF by default. A confirmation is a message to a real household, so it
    // goes out because she ticked the box, never because the dialog assumed.
    var sendConfirmation by remember(invoice.id) { mutableStateOf(false) }
    val amountValue = amount.trim().toDoubleOrNull()
    val tipValue    = parseOptionalMoney(tip)
    val feeValue    = parseOptionalMoney(fee)
    val totalValue  = parseOptionalMoney(total)
    // THE UNAPPLIED BALANCE, recomputed as she types, so a mis-keyed amount is
    // caught while it is still a typo rather than a payment. Null while a box is
    // half-typed: the dialog then shows nothing rather than a figure derived
    // from a number it cannot read.
    val unapplied: Long? = if (amountValue != null && tipValue != null && totalValue != null) {
        val appliedC = dollarsToCents(amountValue)
        val tipC     = dollarsToCents(tipValue)
        val paymentC = if (totalValue > 0.0) dollarsToCents(totalValue) else appliedC + tipC
        unappliedCents(paymentC, appliedC, tipC)
    } else null
    val canSave = amountValue != null && amountValue > 0.0 && method.isNotBlank() &&
        feeValue != null && unapplied != null && unapplied >= 0L
    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Record payment",
        confirmButton = {
            PrimaryButton(
                label   = "Record payment",
                onClick = {
                    onSubmit(
                        buildInvoicePayment(
                            invoice = invoice,
                            amount = amountValue ?: 0.0,
                            paymentMethod = method,
                            referenceNumber = reference,
                            date = date,
                            notes = notes,
                            tip = tipValue ?: 0.0,
                            fee = feeValue ?: 0.0,
                            paymentTotal = totalValue ?: 0.0,
                            autoApply = autoApply,
                            sendConfirmationEmail = sendConfirmation,
                        )
                    )
                },
                loading = submitting,
                enabled = canSave && !submitting,
            )
        },
        dismissButton = { GhostButton(label = "Cancel", onClick = onDismiss) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieField(value = amount, onValueChange = { amount = it }, label = "Amount *", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            AuntieField(value = tip, onValueChange = { tip = it }, label = "Tip", placeholder = "before any processor fee", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            AuntieField(value = fee, onValueChange = { fee = it }, label = "Fees", placeholder = "what the processor took", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            AuntieField(value = total, onValueChange = { total = it }, label = "Payment amount, if more than the above", placeholder = "same as amount plus tip", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            AuntieField(value = method, onValueChange = { method = it }, label = "Method *", placeholder = "card, cash, transfer...", modifier = Modifier.fillMaxWidth())
            AuntieField(value = reference, onValueChange = { reference = it }, label = "Reference #", modifier = Modifier.fillMaxWidth())
            AuntieField(value = date, onValueChange = { date = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.fillMaxWidth())
            AuntieField(value = notes, onValueChange = { notes = it }, label = "Notes (staff only)", placeholder = "not shown to the household", modifier = Modifier.fillMaxWidth())
            Text(
                text  = recordPaymentBalanceCopy(unapplied, autoApply),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieCheckbox(checked = autoApply, onCheckedChange = { autoApply = it })
                Text(
                    text  = "Automatically apply any unapplied amount to future invoices",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieCheckbox(checked = sendConfirmation, onCheckedChange = { sendConfirmation = it })
                Text(
                    text  = "Send a confirmation email to the household",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Text(
                text  = "A payment smaller than the balance leaves this invoice open for the rest.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
    }
}
/**
 * The Unapplied Balance line, in words.
 *
 * PURE AND UNIT-TESTED, like every other decision on this screen. It says three
 * different things and which one it says is the point:
 *
 *   nothing readable  a box is half-typed, so no figure is shown rather than one
 *                     derived from a number the dialog cannot read
 *   negative          the mis-key: more is being applied than actually came in
 *   positive          money over, and what happens to it depends on the
 *                     auto-apply switch, so the copy follows the switch
 */
internal fun recordPaymentBalanceCopy(unappliedCents: Long?, autoApply: Boolean): String = when {
    unappliedCents == null ->
        "Unapplied balance: not yet, one of the amounts above cannot be read."
    unappliedCents < 0L ->
        "This payment does not cover the amount applied plus the tip. " +
            "Raise the payment amount, or lower one of the other two."
    unappliedCents == 0L -> "Unapplied balance ${formatCentsUsd(0)}."
    autoApply ->
        "Unapplied balance ${formatCentsUsd(unappliedCents)}, and it will be held as this " +
            "household's account credit for their next invoice."
    else ->
        "Unapplied balance ${formatCentsUsd(unappliedCents)}, and it will not be applied to " +
            "anything unless you switch on auto-apply."
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
                    val dateLabel = session.completedAt.orEmpty().take(10)
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
