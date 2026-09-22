package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.ReceiptText
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.lastReminderLabel
import com.tribetails.auntieos.web.data.mintInvoiceIdempotencyKey
import com.tribetails.auntieos.web.data.reminderOutcomeMessage
import com.tribetails.auntieos.web.data.mintQuoteIdempotencyKey
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.util.nowIso
import kotlinx.coroutines.launch

/**
 * Den invoices view ("The Den · Invoices"). Editorial heading, a three-card stat
 * strip, a filter row, and a single glass list of invoice rows, all built from
 * the shared DenScreenKit so the screen reads as part of the Den.
 *
 * Data wiring: the live invoicesStream() behind Loading / Error / Empty branches,
 * errors surfaced loudly via an Error banner (never swallowed). Paid / outstanding
 * / overdue are decided by the SHARED helpers in InvoiceFilters.kt so the list and
 * the detail screen never disagree, and overdue compares dueDate to TODAY (audit
 * fix) rather than flagging every dated unpaid invoice.
 *
 * Per-row actions are wired to real callables: createInvoice (composer),
 * sendInvoiceReminder (unpaid), reviewAndSendDraftInvoice via postInvoiceEvent
 * (draft), and generateReceipt (paid). onInvoiceClick(invoiceId) routes to the
 * real invoice-detail screen. Results surface via fail-loud banners.
 */

/** Den filter tabs. Mirrors the mockup's All / Unpaid / Paid / Overdue / Drafts row. */
private enum class InvoiceFilter(val label: String) {
    All     ("All"),
    Unpaid  ("Unpaid"),
    Paid    ("Paid"),
    Overdue ("Overdue"),
    Drafts  ("Drafts"),
    Quotes  ("Quotes"),
}

private fun matchesFilter(i: Invoice, filter: InvoiceFilter, todayIso: String): Boolean = when (filter) {
    InvoiceFilter.All     -> true
    // A quote is not a payable invoice, so it never appears in the payable
    // buckets (Unpaid / Paid / Overdue / Drafts); it shows only in All + Quotes.
    InvoiceFilter.Unpaid  -> !invoiceIsQuote(i) && invoiceIsOutstanding(i) && !invoiceIsDraft(i)
    InvoiceFilter.Paid    -> !invoiceIsQuote(i) && invoiceIsPaid(i)
    InvoiceFilter.Overdue -> !invoiceIsQuote(i) && invoiceIsOverdue(i, todayIso)
    InvoiceFilter.Drafts  -> !invoiceIsQuote(i) && invoiceIsDraft(i)
    InvoiceFilter.Quotes  -> invoiceIsQuote(i)
}

private fun matchesQuery(i: Invoice, query: String): Boolean {
    if (query.isBlank()) return true
    val q = query.trim().lowercase()
    return i.invoiceNumber.lowercase().contains(q) ||
        i.kinfolkName.lowercase().contains(q) ||
        i.client.lowercase().contains(q) ||
        formatMoney(i.total).lowercase().contains(q)
}

/** A household facet option (spec 16.2). Empty [id] = "All households" sentinel. */
internal data class HouseholdFacet(val id: String, val name: String)

/** The "All households" sentinel (no filtering). */
internal val ALL_HOUSEHOLDS = HouseholdFacet("", "All households")

/**
 * Distinct households present on the invoices, for the facet picker. Built from the
 * invoices themselves (real kinfolkId + kinfolkName) so no extra stream is needed.
 * "All households" leads; the rest are name-sorted. Pure; unit-tested.
 */
internal fun householdFacets(invoices: List<Invoice>): List<HouseholdFacet> {
    val byId = invoices
        .filter { it.kinfolkId.isNotBlank() }
        .associate { it.kinfolkId to it.kinfolkName.ifBlank { it.client.ifBlank { "Unnamed household" } } }
    return listOf(ALL_HOUSEHOLDS) + byId.map { HouseholdFacet(it.key, it.value) }.sortedBy { it.name.lowercase() }
}

/** True when [facet] is "All households" or the invoice belongs to the picked household. */
internal fun matchesHouseholdFacet(i: Invoice, facet: HouseholdFacet): Boolean =
    facet.id.isBlank() || i.kinfolkId == facet.id

@Composable
fun InvoicesScreen(
    onInvoiceClick: ((invoiceId: String) -> Unit)? = null,
    composeQuoteForKinfolkId: String? = null,
    onQuoteComposerConsumed: () -> Unit = {},
) {
    val client = remember { FirestoreClient() }
    // P0-FLICKER: hoist the Flow via remember so it survives recomposition.
    val state by remember { client.invoicesStream() }.collectAsState(initial = FirestoreResult.Loading)
    val scope = rememberReportingScope()

    // Today as a YYYY-MM-DD prefix; lexical compare on that fixed shape is
    // chronological. Computed once per composition from the platform clock.
    val todayIso = remember { nowIso().take(10) }

    var filter by remember { mutableStateOf(InvoiceFilter.All) }
    var query  by remember { mutableStateOf("") }
    var household by remember { mutableStateOf(ALL_HOUSEHOLDS) }

    // Slice 2: composer dialog + a fail-loud action error banner. WriteResult.Err
    // from createInvoice / generateReceipt is surfaced here, never swallowed.
    var showComposer by remember { mutableStateOf(false) }
    // PART B: quote composer (createQuote). Reuses the invoice composer in quoteMode.
    var showQuoteComposer by remember { mutableStateOf(false) }
    // N1: a notification "Create quote" routes here seeded with a kinfolk; open the
    // composer preselected to that household and consume the trigger so it can't re-fire.
    var quoteSeedKinfolkId by remember { mutableStateOf("") }
    LaunchedEffect(composeQuoteForKinfolkId) {
        val kid = composeQuoteForKinfolkId
        if (!kid.isNullOrBlank()) {
            quoteSeedKinfolkId = kid
            showQuoteComposer = true
            onQuoteComposerConsumed()
        }
    }
    var actionError by remember { mutableStateOf<String?>(null) }

    var actionNotice by remember { mutableStateOf<String?>(null) }
    /**
     * #832: the notice text of a reminder the server refused. The banner turns
     * Warning only while the notice on screen IS that text, so any later action
     * that sets its own notice gets its own (Success) tone without every call
     * site having to clear a flag.
     */
    var reminderRefusalNotice by remember { mutableStateOf<String?>(null) }

    /**
     * #825: the submission each key was minted for, and the key. ONE KEY PER
     * SUBMISSION, NOT PER PRESS.
     *
     * Both composers CLOSE on confirm, so a retry here is not a second press on
     * a still-open dialog -- it is the operator reopening "New invoice" and
     * typing the same invoice again, because the first attempt reported an error
     * this console cannot classify (see MoneyIdempotency.kt). Holding the key
     * against the submission rather than against the dialog is what makes that
     * second attempt land on the first attempt's invoice. It also stops the
     * retry spending a second value from `counters/invoiceNumber`, which is the
     * half of #825 that cannot be repaired afterwards: a consumed sequence value
     * cannot be handed back.
     *
     * The signature is the draft `Invoice` itself (plus `sendToKinfolk` for a
     * quote, which is part of the submission, not a modifier on it: a replay
     * answers with what the FIRST attempt did, and the first attempt is what
     * decided whether the household was notified). `NewInvoiceDialog` builds the
     * draft purely from what was typed -- no clock, no counter -- so re-entering
     * the same invoice rebuilds an equal one and the held key survives.
     */
    var invoiceSubmission by remember { mutableStateOf<Pair<String, String>?>(null) }
    var quoteSubmission by remember { mutableStateOf<Pair<String, String>?>(null) }

    fun invoiceKeyFor(signature: String): String {
        invoiceSubmission?.let { (held, key) -> if (held == signature) return key }
        val minted = mintInvoiceIdempotencyKey()
        invoiceSubmission = signature to minted
        return minted
    }

    fun quoteKeyFor(signature: String): String {
        quoteSubmission?.let { (held, key) -> if (held == signature) return key }
        val minted = mintQuoteIdempotencyKey()
        quoteSubmission = signature to minted
        return minted
    }

    val onReceipt: (String) -> Unit = { invoiceId ->
        scope.launch {
            when (val r = client.generateReceipt(invoiceId)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> { actionError = null; actionNotice = "Receipt generated." }
            }
        }
    }

    /**
     * #832: invoices with a reminder press still waiting on the server. The row
     * button reads this to show "Sending..." and ignore further taps, so a
     * double-tap cannot fire two calls (the server would refuse the second, but
     * the operator should never have been able to send it).
     */
    var remindingIds by remember { mutableStateOf(emptySet<String>()) }

    val onSendReminder: (String) -> Unit = onSendReminder@{ invoiceId ->
        if (invoiceId in remindingIds) return@onSendReminder
        remindingIds = remindingIds + invoiceId
        scope.launch {
            when (val r = client.sendInvoiceReminder(invoiceId)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> {
                    actionError = null
                    val message = reminderOutcomeMessage(r.value)
                    actionNotice = message
                    reminderRefusalNotice = if (r.value.sent) null else message
                }
            }
            remindingIds = remindingIds - invoiceId
        }
    }

    // Review + send a DRAFT invoice: postInvoiceEvent merges status=sent onto the
    // existing doc and fires invoice.updated. familyId is the invoice kinfolkId.
    val onReviewSend: (Invoice) -> Unit = { invoice ->
        scope.launch {
            when (val r = client.reviewAndSendDraftInvoice(invoice._id, invoice.kinfolkId)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> { actionError = null; actionNotice = "Invoice sent." }
            }
        }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Invoices",
            title      = "Getting",
            accentTail = "paid.",
            trailing   = {
                Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
                    GhostButton(label = "Create quote", onClick = { showQuoteComposer = true })
                    NewInvoiceCta(onClick = { showComposer = true })
                }
            },
        )

        Spacer(Modifier.height(AuntieTheme.dims.space5))

        actionError?.let { msg ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Invoice action failed",
                icon  = Lucide.ReceiptText,
                onDismiss = { actionError = null },
                body  = { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) },
            )
            Spacer(Modifier.height(AuntieTheme.dims.space4))
        }

        actionNotice?.let { msg ->
            val refused = msg == reminderRefusalNotice
            AuntieBanner(
                tone  = if (refused) AuntieBannerTone.Warning else AuntieBannerTone.Success,
                title = if (refused) "Reminder not sent" else "Done",
                icon  = Lucide.ReceiptText,
                onDismiss = { actionNotice = null },
                body  = { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim) },
            )
            Spacer(Modifier.height(AuntieTheme.dims.space4))
        }

        when (val s = state) {
            FirestoreResult.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(4) { ShimmerCard(height = 96.dp) }
                }

            // Fail loud: surface the stream error as a dismiss-less Error banner.
            is FirestoreResult.Error ->
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Couldn't load invoices",
                    icon  = Lucide.ReceiptText,
                ) {
                    Text(
                        s.message,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }

            is FirestoreResult.Data -> {
                if (s.value.isEmpty()) {
                    EmptyState()
                } else {
                    SummaryStrip(s.value, todayIso)

                    Spacer(Modifier.height(AuntieTheme.dims.space5))

                    val households = remember(s.value) { householdFacets(s.value) }
                    // Reset a stale facet if the picked household leaves the data set.
                    if (household !in households) household = ALL_HOUSEHOLDS

                    FilterRow(
                        selected      = filter,
                        onSelect      = { filter = it },
                        query         = query,
                        onQueryChange = { query = it },
                        households    = households,
                        household     = household,
                        onHousehold   = { household = it },
                    )

                    Spacer(Modifier.height(AuntieTheme.dims.space4))

                    val sorted = s.value.sortedByDescending {
                        isoDatePrefixOrNull(it.date) ?: isoDatePrefixOrNull(it.dueDate) ?: ""
                    }
                    val visible = sorted.filter {
                        matchesFilter(it, filter, todayIso) &&
                            matchesQuery(it, query) &&
                            matchesHouseholdFacet(it, household)
                    }

                    DenPanel(
                        title    = "Invoices",
                        subtitle = "${visible.size} of ${s.value.size} shown. Tap a row to open the invoice.",
                    ) {
                        if (visible.isEmpty()) {
                            AuntieEmptyState(
                                title   = "Nothing matches that filter",
                                message = "Try a different tab or clear your search.",
                                icon    = Lucide.ReceiptText,
                                compact = true,
                            )
                        } else {
                            InvoiceList(
                                invoices = visible,
                                todayIso = todayIso,
                                onInvoiceClick = onInvoiceClick,
                                onReceipt = onReceipt,
                                onSendReminder = onSendReminder,
                                onReviewSend = onReviewSend,
                                remindingIds = remindingIds,
                            )
                        }
                    }
                }
            }
        }
    }

    if (showComposer) {
        NewInvoiceDialog(
            visible = showComposer,
            client = client,
            onDismiss = { showComposer = false },
            onConfirm = { invoice ->
                showComposer = false
                val key = invoiceKeyFor(invoice.toString())
                scope.launch {
                    when (val r = client.createInvoice(invoice, idempotencyKey = key)) {
                        is WriteResult.Err -> actionError = r.message
                        is WriteResult.Ok -> {
                            actionError = null
                            // #825: the held key goes once the invoice exists.
                            // Keeping it would mean a deliberate second invoice
                            // with identical fields silently replayed the first.
                            invoiceSubmission = null
                            actionNotice = "Invoice created."
                        }
                    }
                }
            },
        )
    }

    if (showQuoteComposer) {
        NewInvoiceDialog(
            visible = showQuoteComposer,
            client = client,
            quoteMode = true,
            initialKinfolkId = quoteSeedKinfolkId,
            onDismiss = { showQuoteComposer = false; quoteSeedKinfolkId = "" },
            // Unused in quote mode, but the param is non-null.
            onConfirm = { showQuoteComposer = false },
            onConfirmQuote = { invoice, sendToKinfolk ->
                showQuoteComposer = false
                val key = quoteKeyFor(listOf(invoice, sendToKinfolk).toString())
                scope.launch {
                    when (val r = client.createQuote(invoice, sendToKinfolk, idempotencyKey = key)) {
                        is WriteResult.Err -> actionError = r.message
                        is WriteResult.Ok -> {
                            actionError = null
                            quoteSubmission = null
                            actionNotice = if (sendToKinfolk) "Quote created and sent." else "Quote created."
                        }
                    }
                }
            },
        )
    }
}

/**
 * Header CTA. Slice 2 wires the "New invoice" button to the createInvoice
 * callable behind flags.invoicesCreate (now on). When the flag is off (e.g. a
 * future kill-switch) we show a quiet "Not wired yet" pill rather than a dead
 * button so the operator is never misled.
 */
@Composable
private fun NewInvoiceCta(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val flags = LocalFeatureFlags.current
    if (flags.invoicesCreate) {
        PrimaryButton(
            label   = "New invoice",
            onClick = onClick,
            leading = {
                Icon(
                    imageVector = Lucide.Plus,
                    contentDescription = null,
                    tint = c.background,
                    modifier = Modifier.height(16.dp),
                )
            },
        )
    } else {
        AuntieStatusPill(
            label = "New invoice · disabled",
            tone  = AuntieStatusTone.Muted,
            mono  = true,
        )
    }
}

@Composable
private fun SummaryStrip(invoices: List<Invoice>, todayIso: String) {
    val outstanding = invoices.filter { invoiceIsOutstanding(it) }
    val outstandingTotal = outstanding.sumOf { it.amountDue }
    val billedTotal = invoices.sumOf { it.total }
    val overdueInvoices = invoices.filter { invoiceIsOverdue(it, todayIso) }
    val overdueCount = overdueInvoices.size

    // Name the worst-overdue invoice + its days-past for the Overdue card subline
    // (mockup intent), computed from real fields only.
    val worstOverdue = overdueInvoices.maxByOrNull { daysOverdue(it, todayIso) ?: 0 }
    val overdueCaption = when {
        worstOverdue == null -> "all clear"
        else -> {
            val who = worstOverdue.kinfolkName.ifBlank { worstOverdue.client.ifBlank { "a kinfolk" } }
            val days = daysOverdue(worstOverdue, todayIso)
            if (days != null) "$who, $days days past" else who
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
    ) {
        StatCard(
            label    = "Outstanding",
            value    = formatMoney(outstandingTotal),
            trend    = "across ${outstanding.size} invoice${if (outstanding.size == 1) "" else "s"}",
            tone     = if (outstandingTotal > 0.0) AuntieStatusTone.Orange else AuntieStatusTone.Success,
            feature  = outstandingTotal > 0.0,
            modifier = Modifier.weight(1.4f),
        )
        // NOTE: mockup labels this "Paid this month" but there is no paidDate on
        // Invoice (paid date lives on Payment.date in the payments collection,
        // which is not joined to invoices). We surface the honest, computable
        // "Billed total" instead of faking a month-bounded paid figure.
        StatCard(
            label    = "Billed total",
            value    = formatMoney(billedTotal),
            trend    = "all invoices on the books",
            tone     = AuntieStatusTone.Teal,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label    = "Overdue",
            value    = "$overdueCount",
            trend    = overdueCaption,
            tone     = if (overdueCount > 0) AuntieStatusTone.Error else AuntieStatusTone.Muted,
            feature  = overdueCount > 0,
            modifier = Modifier.weight(1f),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterRow(
    selected: InvoiceFilter,
    onSelect: (InvoiceFilter) -> Unit,
    query: String,
    onQueryChange: (String) -> Unit,
    households: List<HouseholdFacet>,
    household: HouseholdFacet,
    onHousehold: (HouseholdFacet) -> Unit,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
        ) {
            InvoiceFilter.entries.forEach { f ->
                AuntieChip(
                    label    = f.label,
                    selected = selected == f,
                    onClick  = { onSelect(f) },
                )
            }
        }
        // Kinfolk facet (spec 16.2): pin the list to one household. Only shown when
        // there is more than one household to choose between.
        if (households.size > 2) {
            AuntieSelectField(
                label = "Household",
                options = households,
                selected = household,
                onSelect = onHousehold,
                optionLabel = { it.name },
                modifier = Modifier.widthIn(min = 180.dp),
            )
        }
        AuntieSearchField(
            value         = query,
            onValueChange = onQueryChange,
            placeholder   = "Search invoice #, kinfolk, or amount...",
            onClear       = { onQueryChange("") },
            modifier      = Modifier.weight(1f).widthIn(min = 160.dp),
        )
    }
}

@Composable
private fun InvoiceList(
    invoices: List<Invoice>,
    todayIso: String,
    onInvoiceClick: ((String) -> Unit)?,
    onReceipt: (String) -> Unit,
    onSendReminder: (String) -> Unit,
    onReviewSend: (Invoice) -> Unit,
    remindingIds: Set<String> = emptySet(),
) {
    Column {
        invoices.forEachIndexed { idx, invoice ->
            InvoiceRow(
                invoice,
                todayIso = todayIso,
                onInvoiceClick = onInvoiceClick,
                onReceipt = onReceipt,
                onSendReminder = onSendReminder,
                onReviewSend = onReviewSend,
                reminding = invoice._id in remindingIds,
            )
            if (idx < invoices.lastIndex) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(AuntieTheme.dims.borderHairline)
                        .background(AuntieTheme.colors.borderSoft),
                )
            }
        }
    }
}

@Composable
private fun InvoiceRow(
    invoice: Invoice,
    todayIso: String,
    onInvoiceClick: ((String) -> Unit)?,
    onReceipt: (String) -> Unit,
    onSendReminder: (String) -> Unit,
    onReviewSend: (Invoice) -> Unit,
    reminding: Boolean = false,
) {
    val c = AuntieTheme.colors
    val quote   = invoiceIsQuote(invoice)
    val draft   = invoiceIsDraft(invoice)
    val overdue = invoiceIsOverdue(invoice, todayIso)
    val unpaid  = invoiceIsOutstanding(invoice)
    // #871: the reminder button follows the server's rule, a stored open bill.
    val remindable = invoiceIsRemindable(invoice)

    val (statusLabel, statusTone) = when {
        quote   -> "Quote"   to AuntieStatusTone.Purple
        draft   -> "Draft"   to AuntieStatusTone.Muted
        overdue -> "Overdue" to AuntieStatusTone.Error
        unpaid  -> "Unpaid"  to AuntieStatusTone.Orange
        else    -> "Paid"    to AuntieStatusTone.Success
    }
    val amountColor = statusTone.color(c)

    var rowModifier = Modifier.fillMaxWidth()
    if (onInvoiceClick != null) {
        rowModifier = rowModifier.clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
        ) { onInvoiceClick(invoice._id) }
    }

    Row(
        modifier = rowModifier.padding(
            horizontal = AuntieTheme.dims.space2,
            vertical   = AuntieTheme.dims.space4,
        ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space4),
    ) {
        // Invoice number (mono).
        Column(
            modifier = Modifier.widthIn(min = 84.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text  = "invoice",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                color = c.textDim,
            )
            Text(
                text  = "#${invoice.invoiceNumber.ifBlank { "(none)" }}",
                style = AuntieTheme.typography.mono.copy(fontWeight = FontWeight.Medium),
                color = c.textPrimary,
            )
        }

        // Who: kinfolk avatar + name.
        Row(
            modifier = Modifier.weight(1.7f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
        ) {
            AuntieAvatar(
                initials     = invoice.kinfolkName.ifBlank { invoice.client },
                gradientSeed = invoice.kinfolkId.ifBlank { invoice.kinfolkName },
                size         = 40.dp,
            )
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    text  = invoice.kinfolkName.ifBlank { invoice.client.ifBlank { "Unknown" } },
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                val secondary = invoice.client.takeIf { it.isNotBlank() && it != invoice.kinfolkName }
                if (secondary != null) {
                    Text(secondary, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }

        // Meta: humanized due / paid line (+ days overdue) + linked visits.
        Column(
            modifier = Modifier.weight(1.1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            val days = daysOverdue(invoice, todayIso)
            val line1 = when {
                quote                                  -> "quote"
                draft                                  -> "draft"
                overdue && days != null                -> "$days days overdue"
                invoice.dueDate.isNotBlank() && unpaid -> "due ${humanizeDate(invoice.dueDate)}"
                invoice.date.isNotBlank()              -> "paid ${humanizeDate(invoice.date)}"
                invoice.dueDate.isNotBlank()           -> "due ${humanizeDate(invoice.dueDate)}"
                else                                   -> "no date"
            }
            Text(
                line1,
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                color = if (overdue) c.error else c.textDim,
            )
            // #832: when the household was last chased about this bill, so the
            // operator can see it before pressing Send reminder, not after.
            if (unpaid && !quote && !draft) {
                Text(
                    text  = "reminded ${lastReminderLabel(invoice.reminderNotifiedAtMs)}",
                    style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                    color = c.textDim,
                )
            }
            val visitCount = invoice.sessionIds.size
            if (visitCount > 0) {
                Text(
                    text  = "linked to $visitCount visit${if (visitCount == 1) "" else "s"}",
                    style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                    color = c.accent,
                )
            }
        }

        // Right: amount + status pill + action.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space4),
        ) {
            Text(
                text  = formatMoney(invoice.total),
                style = AuntieTheme.typography.titleLarge,
                color = amountColor,
            )
            AuntieStatusPill(label = statusLabel, tone = statusTone, mono = true)
            RowAction(
                quote = quote,
                draft = draft,
                unpaid = unpaid,
                remindable = remindable,
                onReceipt = { onReceipt(invoice._id) },
                onSendReminder = { onSendReminder(invoice._id) },
                onReviewSend = { onReviewSend(invoice) },
                reminding = reminding,
            )
        }
    }
}

/**
 * Per-row action button. All variants are wired to real callables:
 *   - draft  -> reviewAndSendDraftInvoice (postInvoiceEvent status=sent)
 *   - unpaid AND a stored open bill -> sendInvoiceReminder (#871)
 *   - unpaid but not an open bill (cancelled, credit, unstamped) -> no action
 *   - paid   -> generateReceipt
 * The generate-receipt variant remains behind flags.invoicesGenerateReceipt
 * (default on) as a kill-switch.
 */
@Composable
private fun RowAction(
    quote: Boolean,
    draft: Boolean,
    unpaid: Boolean,
    remindable: Boolean,
    onReceipt: () -> Unit,
    onSendReminder: () -> Unit,
    onReviewSend: () -> Unit,
    reminding: Boolean = false,
) {
    val c = AuntieTheme.colors
    val flags = LocalFeatureFlags.current
    when {
        // A quote's accept/deny lives on the kinfolk side; there is no admin-side
        // payable action (no reminder/receipt), so the row carries no action button.
        quote -> { /* status pill alone conveys the quote state */ }
        draft -> PrimaryButton(label = "Review & send", onClick = onReviewSend)
        // #871: a balance on a cancelled invoice, a credit or an unstamped doc is
        // not a bill to chase, and a receipt would claim a payment. No action.
        unpaid && !remindable -> { /* nothing to remind about, nothing to receipt */ }
        unpaid -> PrimaryButton(
            label = if (reminding) "Sending..." else "Send reminder",
            onClick = { if (!reminding) onSendReminder() },
            enabled = !reminding,
            leading = {
            Icon(
                imageVector = Lucide.Bell,
                contentDescription = null,
                tint = c.background,
                modifier = Modifier.height(14.dp),
            )
        })
        else -> if (flags.invoicesGenerateReceipt) {
            GhostButton(label = "Receipt", onClick = onReceipt)
        } else {
            DisabledPill("receipt")
        }
    }
}

/** A quiet muted pill for a per-row action whose kill-switch flag is OFF. The
 *  feature is built + live by default; this only appears if an admin disables it. */
@Composable
private fun DisabledPill(action: String) {
    AuntieStatusPill(
        label = "$action · disabled",
        tone  = AuntieStatusTone.Muted,
        mono  = true,
    )
}

@Composable
private fun EmptyState() {
    AuntieEmptyState(
        title   = "No invoices on the books yet",
        message = "Tap New invoice up top to create the first one. Outstanding sit on top, paid tuck beneath.",
        icon    = Lucide.ReceiptText,
    )
}
