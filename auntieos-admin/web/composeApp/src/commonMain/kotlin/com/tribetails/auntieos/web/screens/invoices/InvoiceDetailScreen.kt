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
import com.tribetails.auntieos.web.observability.rememberReportingScope
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
import com.tribetails.auntieos.web.data.CheckedSend
import com.tribetails.auntieos.web.data.SendCheckAction
import com.tribetails.auntieos.web.data.SilenceKind
import com.tribetails.auntieos.web.data.checkedSend
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.howToPayRowsForInvoice
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.lastReminderLabel
import com.tribetails.auntieos.web.data.LINK_ADDS_NO_PRICE_TEXT
import com.tribetails.auntieos.web.data.LINK_ADDS_NO_PRICE_TITLE
import com.tribetails.auntieos.web.data.linkPickerBilledIds
import com.tribetails.auntieos.web.data.linkPickerCancelled
import com.tribetails.auntieos.web.data.linkPickerOnOtherInvoice
import com.tribetails.auntieos.web.data.toggleLinkPick
import com.tribetails.auntieos.web.data.reminderOutcomeMessage
import com.tribetails.auntieos.web.data.InvoicePaymentEntry
import com.tribetails.auntieos.web.data.PaymentSubmissionKeys
import com.tribetails.auntieos.web.data.receiptGeneratedMessage
import com.tribetails.auntieos.web.data.recordPaymentOutcomeMessage
import com.tribetails.auntieos.web.data.recordPaymentRefusalText
import com.tribetails.auntieos.web.data.submitInvoicePayment
import com.tribetails.auntieos.web.data.invoiceSessionLinksSavedText
import com.tribetails.auntieos.web.util.openUrl
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
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

// The header Receipt / Send-reminder actions and the Payments panel's Record
// payment (real generateReceipt / sendInvoiceReminder / recordPayment callables)
// are offered per invoiceActionsFor on the stored stamp (#871, #1238). The Payments panel renders the REAL per-invoice
// join first (paymentsForInvoice via the populated Payment.invoiceId); when no
// payment is linked yet it falls back to the BROADER, kinfolk-level "payments for
// this client" list under a clearly-labeled "NOT INVOICE-LINKED" banner so the
// operator is never misled into thinking those belong to THIS invoice.

@Composable
fun InvoiceDetailScreen(
    invoiceId: String,
    onBack: () -> Unit = {},
    /** #1199: opens the visit a bound line bills for. Null hides the button. */
    onOpenVisit: ((String) -> Unit)? = null,
) {
    val client = remember { FirestoreClient() }
    // P0-FLICKER: hoist Flow construction via remember so the same Flow survives recomposition.
    val streamState by remember { client.invoicesStream() }.collectAsState(initial = FirestoreResult.Loading)

    val state = invoiceDetailStateFor(invoiceId, streamState)

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "Care Ops · Invoices",
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
                invoice     = state.invoice,
                client      = client,
                onOpenVisit = onOpenVisit,
            )
        }
    }
}

@Composable
private fun InvoiceDetailBody(
    invoice: Invoice,
    client: FirestoreClient,
    onOpenVisit: ((String) -> Unit)?,
) {
    val c = AuntieTheme.colors
    val todayKey = nowIso().take(10)
    // #1199: the STORED stamp (ADR-0002), as web and Android read it. Never
    // amountDue: a credit is not paid and a draft is not outstanding.
    val badge = invoiceDetailBadgeFor(invoice, todayKey)
    val statusTone = badge.tone
    val statusText = badge.label
    val statusIcon = when {
        badge.overdue -> Lucide.CircleAlert
        else -> when (badge.state) {
            InvoiceState.PAID, InvoiceState.REDEEMED -> Lucide.CircleCheckBig
            InvoiceState.OPEN, InvoiceState.DRAFT -> Lucide.Clock
            InvoiceState.QUOTE, InvoiceState.ZERO -> Lucide.FileText
            InvoiceState.CANCELLED -> Lucide.X
            InvoiceState.CREDIT, null -> Lucide.CircleAlert
        }
    }
    val accent     = statusTone.colorOf()
    val amountTone = if (badge.state == InvoiceState.PAID) KeyValueStyle.AccentSuccess else KeyValueStyle.AccentError
    val linesPanel = invoiceDetailLinesPanelOf(invoice)
    // #1238: what this invoice may be offered, from the same stored stamp as
    // the badge. Overdue and part paid do not change it.
    // #2168: an archived invoice is read-only until restored, so it offers no
    // send, no Edit and no Link sessions; Restore is the way back.
    val archived = invoiceIsArchived(invoice)
    val actions = invoiceActionsOffered(badge.state, archived)

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
    // invoiceId so the join above is populated.
    //
    // #881: it goes through the `recordPayment` callable, one call with an
    // `apply` for this invoice (see InvoicePaymentEntry). Until #881 it wrote the
    // `payments` row directly over REST, which left the invoice open, the
    // account balance untouched, and no audit entry or confirmation.
    var showRecordPayment by remember { mutableStateOf(false) }
    var recordingPayment  by remember { mutableStateOf(false) }
    // The callable's refusal, shown inside the dialog, which stays open with
    // every field filled in so the operator can correct and press again.
    var recordPaymentError by remember(invoice._id) { mutableStateOf<String?>(null) }

    /**
     * #825 and #881: ONE KEY PER SUBMISSION, NOT PER PRESS. A failed attempt
     * leaves the dialog open, so the next press is a retry of the same payment
     * and carries the same key; a changed entry mints a new one. Remembered per
     * invoice so reopening the dialog with the same entries keeps the key.
     */
    val paymentKeys = remember(invoice._id) { PaymentSubmissionKeys() }

    // Edit-mode state
    var editMode     by remember { mutableStateOf(false) }
    var pendingIds   by remember(invoice._id) { mutableStateOf(invoice.sessionIds.toSet()) }
    var saveLoading  by remember { mutableStateOf(false) }
    var receiptLoading  by remember { mutableStateOf(false) }
    var reminderLoading by remember { mutableStateOf(false) }
    // Seeded from the stored stamp, moved to the server's answer after a press.
    var lastReminderAtMs by remember(invoice._id, invoice.reminderNotifiedAtMs) { mutableStateOf(invoice.reminderNotifiedAtMs) }
    // #1507: the stamp's companion, moved only by a send THIS press made.
    var lastReminderAppOnly by remember(invoice._id, invoice.reminderNotifiedAppOnly) { mutableStateOf(invoice.reminderNotifiedAppOnly == true) }
    var pdfLoading      by remember { mutableStateOf(false) }
    var toastMsg     by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastIsError by remember { mutableStateOf(false) }

    val scope = rememberReportingScope()

    fun showToast(msg: String, isError: Boolean) {
        toastMsg = msg; toastIsError = isError; toastVisible = true
    }

    // #2168: Restore. A restore that could not take every visit back says which
    // in a warning that stays until dismissed, as on web and Android; a plain
    // restore is a toast.
    var askRestore    by remember(invoice._id) { mutableStateOf(false) }
    var restoring     by remember(invoice._id) { mutableStateOf(false) }
    var restoreNotice by remember(invoice._id) { mutableStateOf<String?>(null) }
    fun restoreNow() {
        if (restoring) return
        askRestore = false
        restoring = true
        scope.launch {
            when (val r = client.unarchiveInvoice(invoice._id)) {
                is WriteResult.Err -> showToast("Couldn't restore: ${r.message}", true)
                is WriteResult.Ok  -> {
                    val sentence = invoiceRestoredText(r.value)
                    if (r.value.isBlank()) showToast(sentence, false) else restoreNotice = sentence
                }
            }
            restoring = false
        }
    }

    // #2088: turn the quote into a draft invoice ("convert") or withdraw it
    // ("withdraw"). One callable each, one transaction server-side; the
    // server's refusal is the toast, verbatim.
    var quotePrompt   by remember(invoice._id) { mutableStateOf<String?>(null) }
    var changingQuote by remember(invoice._id) { mutableStateOf(false) }
    fun quoteActionNow(action: String) {
        if (changingQuote) return
        changingQuote = true
        scope.launch {
            if (action == "convert") {
                when (val r = client.convertQuoteToInvoice(invoice._id)) {
                    is WriteResult.Err -> showToast("Couldn't turn it into an invoice: ${r.message}", true)
                    is WriteResult.Ok  -> showToast(QUOTE_CONVERTED_TEXT, false)
                }
            } else {
                when (val r = client.withdrawQuote(invoice._id)) {
                    is WriteResult.Err -> showToast("Couldn't withdraw it: ${r.message}", true)
                    is WriteResult.Ok  -> showToast(quoteWithdrawnText(r.value), false)
                }
            }
            changingQuote = false
            quotePrompt = null
        }
    }

    // #1197: the server's refusal, shown inside the Link Sessions dialog, which
    // stays open with the operator's picks intact so they can correct and retry.
    var linkSessionsError by remember(invoice._id) { mutableStateOf<String?>(null) }

    /**
     * #1197: ONE callable, `linkInvoiceSessions`, owns both directions (the
     * invoice's `sessionIds` and each touched visit's `invoiceId`) in one server
     * transaction, as on Android. The console sends the full set it holds; the
     * server derives what was added and removed against the STORED set. Until
     * #1197 this PATCHed the invoice over REST, which firestore.rules refuses.
     */
    fun saveLinks() {
        if (saveLoading) return
        val newIds = pendingIds.toList()
        saveLoading = true
        linkSessionsError = null
        scope.launch {
            when (val r = client.linkInvoiceSessions(invoice._id, newIds)) {
                is WriteResult.Err -> {
                    saveLoading = false
                    linkSessionsError = "Could not save: ${r.message}"
                }
                is WriteResult.Ok -> {
                    saveLoading = false
                    editMode = false
                    showToast(invoiceSessionLinksSavedText(r.value), false)
                }
            }
        }
    }

    // ── #1174: the invoice editor (updateInvoice) ─────────────────────────────
    // Offered per the STORED editScope, as on web; the server enforces and its
    // refusal stays in the form, verbatim, with every field as typed.
    var invoiceEdit       by remember(invoice._id) { mutableStateOf<InvoiceEditDraft?>(null) }
    var invoiceEditError  by remember(invoice._id) { mutableStateOf<String?>(null) }
    var savingInvoiceEdit by remember(invoice._id) { mutableStateOf(false) }
    val canEditInvoice = invoiceEditScopeOf(invoice) != InvoiceEditScope.NONE && !archived
    fun saveInvoiceEdit() {
        val draft = invoiceEdit ?: return
        if (savingInvoiceEdit) return
        // A patch of what the form controls and the operator changed, built
        // against the invoice as it now stands. Never a rebuilt invoice.
        val outcome = invoiceEditPatchOf(invoice, draft)
        val patch = outcome.patch
        if (patch == null) {
            invoiceEditError = outcome.error
            return
        }
        savingInvoiceEdit = true
        invoiceEditError = null
        scope.launch {
            when (val r = client.updateInvoice(invoice._id, patch)) {
                is WriteResult.Ok -> {
                    savingInvoiceEdit = false
                    invoiceEdit = null
                    showToast("Invoice updated.", false)
                }
                is WriteResult.Err -> {
                    savingInvoiceEdit = false
                    invoiceEditError = "Could not save: ${r.message}"
                }
            }
        }
    }
    InvoiceEditDialog(
        draft     = invoiceEdit,
        error     = invoiceEditError,
        saving    = savingInvoiceEdit,
        onChange  = { if (!savingInvoiceEdit) invoiceEdit = it },
        onSave    = { saveInvoiceEdit() },
        onDismiss = {
            if (!savingInvoiceEdit) {
                invoiceEdit = null
                invoiceEditError = null
            }
        },
    )
    // ── Edit dialog: "Link Sessions" ──────────────────────────────────────────
    LinkSessionsDialog(
        visible       = editMode,
        sessionsState = sessionsState,
        pendingIds    = pendingIds,
        saveLoading   = saveLoading,
        error         = linkSessionsError,
        invoiceId     = invoice._id,
        storedIds     = invoice.sessionIds,
        billedIds     = linkPickerBilledIds(invoice.lineItems),
        linesEditable = invoiceEditScopeOf(invoice) == InvoiceEditScope.ALL,
        onToggle      = { sid ->
            // #1254: a visit another invoice bills cannot be ticked.
            // #2091: a visit a line bills cannot be unticked.
            if (!saveLoading) {
                pendingIds = toggleLinkPick(
                    pendingIds, sid, allSessions, invoice._id, invoice.sessionIds, linkPickerBilledIds(invoice.lineItems),
                )
            }
        },
        // Not while the call is in flight: its answer has to land somewhere.
        onCancel      = {
            if (!saveLoading) {
                editMode = false
                linkSessionsError = null
            }
        },
        onSave        = { saveLinks() },
    )

    // ── Record-payment dialog (recordPayment callable with an apply, #881) ────
    RecordPaymentDialog(
        visible    = showRecordPayment,
        invoice    = invoice,
        submitting = recordingPayment,
        error      = recordPaymentError,
        onDismiss  = {
            // Not while the call is in flight: its answer has to land somewhere.
            if (!recordingPayment) {
                showRecordPayment = false
                recordPaymentError = null
            }
        },
        onInvalid  = { message -> recordPaymentError = message },
        onSubmit   = { entry ->
            if (recordingPayment) return@RecordPaymentDialog
            recordingPayment = true
            recordPaymentError = null
            scope.launch {
                // Holds the key on Err and releases it on Ok (submitInvoicePayment).
                when (val r = submitInvoicePayment(client, entry, paymentKeys)) {
                    is WriteResult.Ok  -> {
                        recordingPayment = false
                        showRecordPayment = false
                        // #1511: a confirmation that reached the household in the app
                        // only is not the green toast, as for the reminder below.
                        showToast(
                            recordPaymentOutcomeMessage(r.value, entry.sendConfirmationEmail),
                            entry.sendConfirmationEmail && r.value.confirmationAppOnly,
                        )
                    }
                    is WriteResult.Err -> {
                        recordingPayment = false
                        recordPaymentError = recordPaymentRefusalText(r.message)
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

        restoreNotice?.let { notice ->
            AuntieBanner(
                tone      = AuntieBannerTone.Warning,
                title     = "Done, but not all of it",
                onDismiss = { restoreNotice = null },
            ) {
                Text(notice, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }
        // #2195: an archived quote is hidden from the household, and says so.
        val archivedQuote = isArchivedQuote(invoice)
        if (archived) {
            AuntieBanner(tone = AuntieBannerTone.Info, title = "Archived") {
                Text(
                    if (archivedQuote) ARCHIVED_QUOTE_TEXT else ARCHIVED_INVOICE_TEXT,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
        AuntieDialog(
            visible   = askRestore,
            title     = if (archivedQuote) "Restore this quote?" else "Restore this invoice?",
            onDismiss = { askRestore = false },
            footer    = {
                GhostButton(label = "Cancel", onClick = { askRestore = false })
                PrimaryButton(label = if (archivedQuote) "Restore quote" else "Restore invoice", onClick = { restoreNow() })
            },
        ) {
            Text(
                if (archivedQuote) RESTORE_QUOTE_CONFIRM_TEXT else RESTORE_CONFIRM_TEXT,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
        // #2088: turn the quote into an invoice, or withdraw it, behind a confirm.
        quotePrompt?.let { action ->
            AuntieDialog(
                visible   = true,
                title     = if (action == "convert") "Turn this quote into an invoice?" else "Withdraw this quote?",
                onDismiss = { if (!changingQuote) quotePrompt = null },
                footer    = {
                    GhostButton(label = "Cancel", onClick = { if (!changingQuote) quotePrompt = null })
                    PrimaryButton(
                        label   = when {
                            changingQuote -> "Working..."
                            action == "convert" -> "Turn into invoice"
                            else -> "Withdraw quote"
                        },
                        onClick = { quoteActionNow(action) },
                        enabled = !changingQuote,
                    )
                },
            ) {
                Text(
                    if (action == "convert") CONVERT_QUOTE_CONFIRM_TEXT else WITHDRAW_QUOTE_CONFIRM_TEXT,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }

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
                label   = invoiceAmountDueLabelFor(badge),
                value   = formatMoney(invoice.amountDue),
                trend   = badge.amountTrend,
                tone    = statusTone,
                feature = true,
                modifier = Modifier.weight(1f),
            )
        }

        // Header actions: Generate receipt (generateReceipt callable) and Send
        // reminder (sendInvoiceReminder callable). Both real, fail-loud via toast,
        // and each offered only where invoiceActionsFor allows it (#1238).
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (canEditInvoice) GhostButton(
                label   = "Edit",
                onClick = {
                    invoiceEditError = null
                    invoiceEdit = invoiceEditDraftOf(invoice)
                },
                leading = { Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            // #1238: a receipt claims a payment, so only a stored paid invoice
            // offers one, as on web and Android.
            if (InvoiceAction.GENERATE_RECEIPT in actions) GhostButton(
                label   = if (receiptLoading) "Generating..." else "Generate receipt",
                onClick = {
                    if (receiptLoading || reminderLoading) return@GhostButton
                    receiptLoading = true
                    scope.launch {
                        // #1567: a send that times out is re-read, never reported as failed.
                        val checked = checkedSend(SendCheckAction.RECEIPT, { client.invoiceSendMarks(invoice._id) }) {
                            client.generateReceipt(invoice._id)
                        }
                        when (checked) {
                            is CheckedSend.Silent -> showToast(checked.outcome.message, checked.outcome.kind != SilenceKind.SENT)
                            is CheckedSend.Answered -> when (val r = checked.result) {
                                is WriteResult.Err -> showToast("Couldn't generate receipt: ${r.message}", true)
                                // #1511: honest about where the notice went, and not green when app-only.
                                is WriteResult.Ok  -> showToast(receiptGeneratedMessage(r.value.appOnly), r.value.appOnly)
                            }
                        }
                        receiptLoading = false
                    }
                },
                enabled = !receiptLoading && !reminderLoading,
                leading = { Icon(Lucide.ReceiptText, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            var askReminder by remember { mutableStateOf(false) }
            fun sendReminderNow() {
                    if (receiptLoading || reminderLoading) return
                    reminderLoading = true
                    scope.launch {
                        val checked = checkedSend(SendCheckAction.REMINDER, { client.invoiceSendMarks(invoice._id) }) {
                            client.sendInvoiceReminder(invoice._id)
                        }
                        if (checked is CheckedSend.Silent) {
                            showToast(checked.outcome.message, checked.outcome.kind != SilenceKind.SENT)
                        } else when (val r = (checked as CheckedSend.Answered).result) {
                            is WriteResult.Err -> showToast("Couldn't send reminder: ${r.message}", true)
                            // #832: a refusal inside the server's window is not a
                            // failure, but it is not "sent" either. Say which,
                            // and when, and move the Last reminder row now.
                            is WriteResult.Ok  -> {
                                // Only a real time moves the row; null never blanks a stamp.
                                r.value.lastReminderAtMs?.let { lastReminderAtMs = it }
                                // #1507: a refusal says nothing about the earlier reminder's channels.
                                if (r.value.sent) lastReminderAppOnly = r.value.appOnly
                                // An app-only send is not a green toast either: the words say
                                // no email or text went out, and the tone agrees with them.
                                showToast(reminderOutcomeMessage(r.value), !r.value.sent || r.value.appOnly)
                            }
                        }
                        reminderLoading = false
                    }
                }
            // #871: offered only for a stored open bill, the rule the server
            // enforces, so a cancelled invoice or a quote never shows the button.
            // #1609: the button opens a confirm naming who the reminder reaches.
            if (askReminder) {
                SendConfirmDialog(
                    client = client,
                    invoiceId = invoice._id,
                    send = HouseholdSend.REMINDER,
                    onConfirm = {
                        askReminder = false
                        sendReminderNow()
                    },
                    onDismiss = { askReminder = false },
                )
            }
            if (InvoiceAction.SEND_REMINDER in actions) GhostButton(
                label   = if (reminderLoading) "Sending..." else "Send reminder",
                onClick = {
                    if (receiptLoading || reminderLoading) return@GhostButton
                    askReminder = true
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
            // #2088: once a quote exists the office can turn it into an invoice
            // or withdraw it, while it is not accepted and not archived.
            if (quoteIsChangeable(invoice)) {
                GhostButton(
                    label   = "Turn into invoice",
                    onClick = { quotePrompt = "convert" },
                    enabled = !changingQuote,
                )
                GhostButton(
                    label   = "Withdraw quote",
                    onClick = { quotePrompt = "withdraw" },
                    enabled = !changingQuote,
                )
            }
            // #2168: the way back from read-only. The console has no Archive
            // of its own; an invoice archived on web or Android is restored here.
            if (archived) GhostButton(
                label   = if (restoring) "Restoring..." else "Restore",
                onClick = { if (!restoring) askRestore = true },
                enabled = !restoring,
            )
        }

        // ── Billing panel ────────────────────────────────────────────────────
        DenPanel(title = "Billing") {
            Column {
                DetailRow("Client",   invoice.client.ifBlank { "-" })
                DetailRow("Date",     invoice.date.ifBlank { "-" })
                // #1570: a stored due date that names no day is never counted
                // overdue, so the row says so beside it.
                DetailRow(
                    "Due date",
                    when {
                        invoice.dueDate.isBlank() -> "-"
                        isUnreadableDueDate(invoice.dueDate) ->
                            "${invoice.dueDate.trim()} (not a date this app can read, so it is never counted overdue)"
                        else -> invoice.dueDate
                    },
                )
                DetailRow("Last reminder", lastReminderLabel(lastReminderAtMs, appOnly = lastReminderAppOnly))
                if (invoice.terms.isNotBlank()) DetailRow("Terms", invoice.terms)
                if (invoice.address.isNotBlank()) DetailRow("Address", invoice.address)
            }
        }

        // ── Line items (#1199) ─────────────────────────────────────────────────
        // Read-only here; typed lines change through Edit (#1174). A bound line
        // (#408) got its money from the visit, so it says so and offers the visit.
        DenPanel(title = "Line items") {
            Column {
                when (val panel = linesPanel) {
                    is InvoiceDetailLinesPanel.Lines -> {
                        panel.rows.forEachIndexed { idx, row ->
                            InvoiceDetailLineItemRow(row, showDivider = idx > 0, onOpenVisit = onOpenVisit)
                        }
                        DetailRow("Subtotal", formatEditCents(panel.subtotalCents))
                        if (panel.invoiceDiscountCents > 0) {
                            DetailRow("Invoice discount", "-" + formatEditCents(panel.invoiceDiscountCents))
                        }
                        DetailRow("Total from these lines", formatEditCents(panel.totalCents), style = KeyValueStyle.Total)
                    }
                    else -> EmptyHint(invoiceDetailLinesEmptyCopy(panel).orEmpty())
                }
            }
        }

        // #1239: the stored total disagrees with the lines above. Names both
        // figures and reconciles neither, as web and Android do: picking a
        // winner, or quietly showing the derived figure, would hide the drift
        // from the only person who can resolve it.
        invoiceTotalDisagreementOf(invoice)?.let { drift ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = INVOICE_TOTAL_DISAGREEMENT_TITLE,
                body  = {
                    Text(
                        invoiceTotalDisagreementText(drift),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                },
            )
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
                // #1240: a part-paid invoice names the payment already taken,
                // as web's "Paid so far" fact does, beside what is still owed.
                badge.partPaid?.let { part ->
                    DetailRow(
                        "Paid so far",
                        formatEditCents(part.paidCents),
                        style     = KeyValueStyle.AccentSuccess,
                        valueMono = true,
                    )
                }
                DetailRow(
                    invoiceAmountDueLabelFor(badge),
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
        InvoicePaymentsPanel(
            invoice         = invoice,
            actions         = actions,
            paymentsState   = paymentsState,
            linkedPayments  = linkedPayments,
            clientPayments  = clientPayments,
            onRecordPayment = { showRecordPayment = true },
        )

        // ── Account credit (#1872) ─────────────────────────────────────────────
        // Never spent automatically: it goes onto this invoice only here, as an
        // amount she types and confirms. Offered where Record payment is, and
        // not on an archived invoice.
        if (offersApplyCredit(invoice, actions)) {
            InvoiceApplyCreditPanel(
                invoice   = invoice,
                client    = client,
                onApplied = { sentence -> showToast(sentence, false) },
            )
        }

        // ── Linked Sessions section ───────────────────────────────────────────
        LinkedSessionsSection(
            invoice         = invoice,
            linkedSessions  = linkedSessions,
            sessionsState   = sessionsState,
            onOpenEdit      = { pendingIds = invoice.sessionIds.toSet(); linkSessionsError = null; editMode = true },
            canLink         = !archived,
        )

        // How-to-pay (#1200): the methods the household is offered on this invoice,
        // resolved as the server resolves them. Hidden when none is offered.
        HowToPayPanel(invoice = invoice, settings = businessSettings)
    }
}

/**
 * The Payments panel. #1238: pulled out of the detail body so jvmTest can render
 * it. Record payment follows [actions]; what is already recorded (the linked
 * rows, the disclosed client-level rows and the legacy paymentsHistory text)
 * renders in every state, paid and cancelled included.
 */
@Composable
internal fun InvoicePaymentsPanel(
    invoice: Invoice,
    actions: List<InvoiceAction>,
    paymentsState: FirestoreResult<List<Payment>>,
    linkedPayments: List<Payment>,
    clientPayments: List<Payment>,
    onRecordPayment: () -> Unit,
) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Payments",
        // #1238: gated to the states that can take a payment, so a paid,
        // cancelled, quoted, draft or credit invoice cannot collect twice or
        // collect early. Recorded payments below render in every state.
        trailing = {
            if (InvoiceAction.RECORD_PAYMENT in actions) {
                GhostButton(label = "Record payment", onClick = onRecordPayment)
            }
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
                        "Couldn't load payments: ${paymentsState.message}",
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
                    EmptyHint(invoicePaymentsEmptyCopy(actions))
            }
        }
    }
}

@Composable
internal fun HowToPayPanel(invoice: Invoice, settings: BusinessSettings?) {
    val methods = howToPayRowsForInvoice(invoice, settings)
    if (methods.isEmpty()) return
    val c = AuntieTheme.colors
    DenPanel(title = "How to pay") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            methods.forEach { row ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        row.label,
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                        modifier = Modifier.padding(end = 16.dp),
                    )
                    // Instructions run to 500 characters, so the detail takes the
                    // remaining width and wraps instead of squeezing the label.
                    Text(
                        row.detail,
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                        textAlign = androidx.compose.ui.text.style.TextAlign.End,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

/** Resolve a tone to its brand color via the shared AuntieStatusTone.color extension. */
@Composable
private fun AuntieStatusTone.colorOf() = this.color(AuntieTheme.colors)

/** One stored line (#1199), with the #408 note and the route to its visit when it is bound. */
@Composable
private fun InvoiceDetailLineItemRow(
    row: InvoiceDetailLineRow,
    showDivider: Boolean,
    onOpenVisit: ((String) -> Unit)?,
) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val ruleColor = c.borderSoft
    Column {
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
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    row.description,
                    style = AuntieTheme.typography.bodySmall,
                    color = if (row.descriptionMissing) c.textDim else c.textPrimary,
                )
                Text(row.detail, style = AuntieTheme.typography.labelSmall, color = c.textDim)
            }
            Text(formatEditCents(row.amountCents), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        }
        val sessionId = row.boundSessionId
        if (sessionId != null) {
            Column(
                modifier = Modifier.padding(bottom = 9.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(INVOICE_DETAIL_BOUND_LINE_NOTE, style = AuntieTheme.typography.labelSmall, color = c.textDim)
                if (onOpenVisit != null) {
                    GhostButton(label = "Open this visit", onClick = { onOpenVisit(sessionId) })
                }
            }
        }
    }
}

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
 * Record-payment dialog prefilled from the invoice. #881: the fields are the
 * `recordPayment` callable's (amount paid, apply to this invoice, gross tip,
 * processor fee, auto-apply, send confirmation), checked by
 * [parseRecordPaymentForm]. While the call runs the button says so and nothing
 * can be pressed twice; a refusal is shown here and the fields stay filled in.
 */
@Composable
private fun RecordPaymentDialog(
    visible: Boolean,
    invoice: Invoice,
    submitting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onInvalid: (String) -> Unit,
    onSubmit: (InvoicePaymentEntry) -> Unit,
) {
    // Seeded ungrouped ("1234.50"): `recordPaymentSplit` parses this field back,
    // and the grouped `formatMoney` text would not parse (#1488).
    val due = if (invoice.amountDue > 0.0) {
        centsToInputDollars(com.tribetails.auntieos.web.util.dollarsToRoundedCents(invoice.amountDue))
    } else {
        ""
    }
    var amount    by remember(invoice._id, visible) { mutableStateOf(due) }
    var apply     by remember(invoice._id, visible) { mutableStateOf(due) }
    var tip       by remember(invoice._id, visible) { mutableStateOf("") }
    var fee       by remember(invoice._id, visible) { mutableStateOf("") }
    var method    by remember(invoice._id, visible) { mutableStateOf("") }
    var reference by remember(invoice._id, visible) { mutableStateOf("") }
    var date      by remember(invoice._id, visible) { mutableStateOf(nowIso().take(10)) }
    var notes     by remember(invoice._id, visible) { mutableStateOf("") }
    // #988: "Leave as account credit", an amount, blank for none. It replaced the
    // auto-apply tick: a leftover is tip unless she enters a credit here.
    var credit    by remember(invoice._id, visible) { mutableStateOf("") }
    var sendConfirmation by remember(invoice._id, visible) { mutableStateOf(false) }
    val canSave = amount.isNotBlank() && apply.isNotBlank() && method.isNotBlank()
    AuntieDialog(
        visible   = visible,
        title     = "Record payment",
        onDismiss = onDismiss,
        hint      = "Applies a payment to invoice #${invoice.invoiceNumber.ifBlank { "-" }}.",
        maxWidth  = 460.dp,
        footer    = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = !submitting)
            Spacer(Modifier.width(8.dp))
            PrimaryButton(
                label   = if (submitting) "Recording..." else "Record payment",
                enabled = canSave && !submitting,
                onClick = {
                    when (val form = parseRecordPaymentForm(
                        invoice, amount, apply, tip, fee, method, reference, date, notes, credit, sendConfirmation,
                    )) {
                        is RecordPaymentForm.Invalid -> onInvalid(form.message)
                        is RecordPaymentForm.Ready   -> onSubmit(form.entry)
                    }
                },
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (error != null) {
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Not recorded",
                    icon  = Lucide.CircleAlert,
                    body  = {
                        Text(error, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    },
                )
            }
            val on = !submitting
            BottomBorderField(amount, { amount = it }, label = "Amount paid *", placeholder = "the whole sum, tip included", keyboardType = KeyboardType.Decimal, enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(apply, { apply = it }, label = "Apply to this invoice *", keyboardType = KeyboardType.Decimal, enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(tip, { tip = it }, label = "Tip (gross)", placeholder = "the rest of the payment", keyboardType = KeyboardType.Decimal, enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(fee, { fee = it }, label = "Processor fee", keyboardType = KeyboardType.Decimal, enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(credit, { credit = it }, label = "Leave as account credit", placeholder = "0.00", keyboardType = KeyboardType.Decimal, enabled = on, modifier = Modifier.fillMaxWidth())
            // #988: where the money goes, before Save.
            Text(
                recordPaymentSplitLine(recordPaymentSplit(amount, apply, tip, credit, invoiceBalanceCents(invoice)), fee),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            BottomBorderField(method, { method = it }, label = "Method *", placeholder = "Venmo, PayPal, cash...", enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(reference, { reference = it }, label = "Reference #", enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(date, { date = it }, label = "Date (YYYY-MM-DD)", enabled = on, modifier = Modifier.fillMaxWidth())
            BottomBorderField(notes, { notes = it }, label = "Staff-only notes", enabled = on, modifier = Modifier.fillMaxWidth())
            AuntieCheckbox(
                checked = sendConfirmation,
                onCheckedChange = { sendConfirmation = it },
                label = "Send a confirmation email to the household",
                enabled = on,
            )
        }
    }
}
@OptIn(ExperimentalLayoutApi::class)
/**
 * #1744: a linked visit's row names its KinCare off the catalog, never the
 * stored `visit_60`. A blank service keeps its "Service" stand-in.
 */
internal fun linkedSessionServiceLabel(serviceType: String, catalog: com.tribetails.auntieos.web.screens.ServiceCatalog): String =
    if (serviceType.isBlank()) "Service" else catalog.nameOf(serviceType)

/** #1744: one link-picker chip: the visit's KinCare name, its day, and why it cannot be ticked. */
internal fun linkPickerChipLabel(
    serviceType: String,
    dateLabel: String,
    elsewhere: Boolean,
    cancelled: Boolean,
    catalog: com.tribetails.auntieos.web.screens.ServiceCatalog,
    /** #2091: a line on this invoice bills it, so it stays linked. */
    billedHere: Boolean = false,
    /** False when the invoice's lines are locked, so Edit cannot remove the line. */
    linesEditable: Boolean = true,
): String {
    val service = if (serviceType.isBlank()) "Session" else catalog.nameOf(serviceType)
    return "$service · $dateLabel" +
        (if (elsewhere) " · on another invoice" else "") +
        (if (cancelled) " · cancelled, not billable" else "") +
        (if (billedHere) linkPickerBilledHereNote(linesEditable) else "")
}
/** #2091: why a billed visit's chip is locked. Edit is named only when Edit can remove the line. Same words as web and Android. */
internal fun linkPickerBilledHereNote(linesEditable: Boolean): String =
    if (linesEditable) " · billed on a line of this invoice, remove the line in Edit to unlink it"
    else " · billed on a line of this invoice, and its lines are locked"

@Composable
private fun LinkSessionsDialog(
    visible: Boolean,
    sessionsState: FirestoreResult<List<KinCareSession>>,
    pendingIds: Set<String>,
    saveLoading: Boolean,
    error: String?,
    invoiceId: String,
    storedIds: List<String>,
    billedIds: Set<String>,
    linesEditable: Boolean,
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
            GhostButton(label = "Cancel", onClick = onCancel, enabled = !saveLoading)
            PrimaryButton(label = "Save", onClick = onSave, loading = saveLoading)
        },
    ) {
        // #1197: the server's refusal, verbatim, above the picks it refused.
        if (error != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't save") {
                Text(error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        // #2091: the moment a new visit is ticked, say that linking adds no price.
        if (pendingIds.any { it !in storedIds }) {
            AuntieBanner(tone = AuntieBannerTone.Warning, title = LINK_ADDS_NO_PRICE_TITLE) {
                Text(LINK_ADDS_NO_PRICE_TEXT, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
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
                            // #1254: shown, not hidden, and not tickable:
                            // another invoice already bills it.
                            val elsewhere = linkPickerOnOtherInvoice(session, invoiceId, storedIds)
                            // #1609: a cancelled visit is not billable.
                            val cancelled = linkPickerCancelled(session, storedIds)
                            // #2091: a line on this invoice bills it; Edit is where it leaves.
                            val billedHere = session._id in billedIds && session._id in storedIds
                            val chipLabel = linkPickerChipLabel(
                                session.serviceType, dateLabel, elsewhere, cancelled, com.tribetails.auntieos.web.screens.LocalServiceCatalog.current,
                                billedHere,
                                linesEditable,
                            )
                            AuntieChip(
                                label    = chipLabel,
                                selected = session._id in pendingIds,
                                tone     = AuntieChipTone.Orange,
                                onClick  = { onToggle(session._id) },
                                enabled  = !elsewhere && !cancelled && !billedHere && !saveLoading,
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
    /** #2168: false on an archived invoice, which links nothing until restored. */
    canLink: Boolean = true,
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
                if (canLink) AuntieIconButton(
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
                if (canLink) GhostButton(
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
                linkedSessionServiceLabel(session.serviceType, com.tribetails.auntieos.web.screens.LocalServiceCatalog.current),
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

/** #2168: the Archived notice, in the same words as web. */
internal const val ARCHIVED_INVOICE_TEXT =
    "This invoice is out of the working list and out of the outstanding and billed totals. It " +
        "has not been deleted or cancelled, and the household can still see it and still pay it."

/** #2168: the Restore confirm, in the same words as web. */
internal const val RESTORE_CONFIRM_TEXT =
    "This puts the invoice back into the working list and back into the outstanding and billed totals. Continue?"

/** #2168: what a restore says, in the same words as web and Android, with the server's notice appended. */
internal fun invoiceRestoredText(notice: String): String =
    if (notice.isBlank()) "Invoice restored to the working list." else "Invoice restored to the working list. $notice"
