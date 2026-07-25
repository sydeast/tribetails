package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.ReceiptText
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.domain.InvoiceAction
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.invoiceActionsFor
import com.tribetails.auntieos.domain.invoiceIsOverdue
import com.tribetails.auntieos.domain.invoiceStateOf
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.ShimmerCard
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.components.color
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Den invoices view ("The Den · Invoices"), ported from the redesigned web spec
 * (web/composeApp/.../screens/invoices/InvoicesScreen.kt) onto the Android
 * AdminDataViewModel contract: an editorial heading, a three-card stat strip, a
 * filter row, and a single glass DenPanel list of invoice rows.
 *
 * Data wiring: drives off the existing [AdminDataViewModel] (invoices / isLoading
 * / error StateFlows). Paid / outstanding / overdue / draft are decided by the
 * local helpers below from real Invoice fields only; overdue compares dueDate to
 * TODAY rather than flagging every dated unpaid invoice.
 *
 * Per-row actions are all wired to live callables on [AdminDataViewModel]: a draft
 * row reviews-and-sends via postInvoiceEvent (reviewAndSendDraftInvoice), an unpaid
 * row sends an on-demand reminder via sendInvoiceReminder, and a paid row generates
 * a receipt via generateReceipt. No control is a dead button; each fires a real call
 * and confirms (or fails) loudly.
 */

/** Den filter tabs. Mirrors the web spec's All / Unpaid / Paid / Overdue / Drafts row. */
private enum class InvoiceFilter(val label: String) {
    All("All"),
    Unpaid("Unpaid"),
    Paid("Paid"),
    Overdue("Overdue"),
    Drafts("Drafts"),
}

// ── invoice facets, all resolved through the SHARED classifier ───────────────
// domain/InvoiceActions.kt is the single source of truth for what an invoice is
// and what may be done to it, so this list and the detail screen can never
// disagree. These stay as named facets because the filter row and the row chip
// read more clearly this way; each is now a positive equality test against the
// enumerated state rather than the old "not draft and not quote, so paid"
// negation (the AO-12 shape, which read an unredeemed credit as PAID).

private fun invoiceIsDraft(i: Invoice): Boolean = invoiceStateOf(i) == InvoiceState.DRAFT

/** A quote is an invoice in QUOTE status (PART B). Pure; unit-tested. */
internal fun invoiceIsQuote(i: Invoice): Boolean = invoiceStateOf(i) == InvoiceState.QUOTE

private fun invoiceIsPaid(i: Invoice): Boolean = invoiceStateOf(i) == InvoiceState.PAID

private fun invoiceIsOutstanding(i: Invoice): Boolean = invoiceStateOf(i) == InvoiceState.OPEN

/** A date prefix in YYYY-MM-DD shape, or null if the field isn't usable. */
private fun isoDatePrefixOrNull(date: String): String? =
    date.trim().take(10).takeIf { it.length == 10 && it[4] == '-' && it[7] == '-' }

/** Whole days the invoice is past due, or null if not computable. */
private fun daysOverdue(i: Invoice, todayIso: String): Int? {
    val due = isoDatePrefixOrNull(i.dueDate) ?: return null
    return runCatching {
        val d = java.time.LocalDate.parse(due)
        val t = java.time.LocalDate.parse(todayIso)
        java.time.temporal.ChronoUnit.DAYS.between(d, t).toInt().takeIf { it > 0 }
    }.getOrNull()
}

/** Compact USD formatting from a Double total. */
private fun formatMoney(amount: Double): String {
    val rounded = (amount * 100.0).let { kotlin.math.round(it) } / 100.0
    val whole = rounded.toLong()
    val cents = kotlin.math.round((rounded - whole) * 100.0).toInt()
    return if (cents == 0) "$$whole" else "$$whole.${cents.toString().padStart(2, '0')}"
}

/** A human-ish "MMM d" style label from a YYYY-MM-DD prefix, or echoes input. */
private fun humanizeDate(date: String): String {
    val iso = isoDatePrefixOrNull(date) ?: return date
    return runCatching {
        val d = java.time.LocalDate.parse(iso)
        val month = d.month.name.lowercase().replaceFirstChar { it.uppercase() }.take(3)
        "$month ${d.dayOfMonth}"
    }.getOrDefault(date)
}

private fun nowDateIso(): String =
    runCatching { java.time.LocalDate.now().toString() }.getOrDefault("9999-12-31")

private fun matchesFilter(i: Invoice, filter: InvoiceFilter, todayIso: String): Boolean = when (filter) {
    InvoiceFilter.All -> true
    // OPEN already excludes drafts and quotes, so the old `&& !invoiceIsDraft(i)`
    // guard is gone: it was compensating for the negation-based helper.
    InvoiceFilter.Unpaid -> invoiceIsOutstanding(i)
    InvoiceFilter.Paid -> invoiceIsPaid(i)
    InvoiceFilter.Overdue -> invoiceIsOverdue(i, todayIso)
    InvoiceFilter.Drafts -> invoiceIsDraft(i)
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
internal val ALL_HOUSEHOLDS = HouseholdFacet("", "All households")

/** Distinct households on the invoices, "All households" first then name-sorted. Pure; tested. */
internal fun householdFacets(invoices: List<Invoice>): List<HouseholdFacet> {
    val byId = invoices
        .filter { it.kinfolkId.isNotBlank() }
        .associate { it.kinfolkId to it.kinfolkName.ifBlank { it.client.ifBlank { "Unnamed household" } } }
    return listOf(ALL_HOUSEHOLDS) + byId.map { HouseholdFacet(it.key, it.value) }.sortedBy { it.name.lowercase() }
}

/** True when [facet] is "All households" or the invoice belongs to the picked household. */
internal fun matchesHouseholdFacet(i: Invoice, facet: HouseholdFacet): Boolean =
    facet.id.isBlank() || i.kinfolkId == facet.id

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun InvoicesScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit,
    onOpenDetail: (invoiceId: String) -> Unit = {},
    composeQuoteFor: String? = null,
) {
    val invoices by viewModel.invoices.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    val kinfolk by viewModel.kinfolkDirectory.collectAsState()
    val actionMessage by viewModel.invoiceActionMessage.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.loadInvoices()
        viewModel.loadKinfolkDirectory()
    }

    val todayIso = remember { nowDateIso() }

    var filter by remember { mutableStateOf(InvoiceFilter.All) }
    var query by remember { mutableStateOf("") }
    var household by remember { mutableStateOf(ALL_HOUSEHOLDS) }
    var showComposer by remember { mutableStateOf(false) }
    // PART B: the same composer drives both invoice and quote creation. quoteMode
    // flips the dialog into "New quote" + the Send-to-kinfolk toggle.
    var quoteMode by remember { mutableStateOf(false) }
    // N1: a notification routed here to compose a quote; open the composer in quote
    // mode preselected to that household.
    var quoteSeedKinfolkId by remember { mutableStateOf("") }
    LaunchedEffect(composeQuoteFor) {
        val kid = composeQuoteFor
        if (!kid.isNullOrBlank()) {
            quoteSeedKinfolkId = kid
            quoteMode = true
            showComposer = true
        }
    }

    AuntieScreenScaffold(title = "Invoices", onBack = onBack) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh = { viewModel.loadInvoices() },
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                contentPadding = PaddingValues(vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space4),
            ) {
                item {
                    DenScreenHeading(
                        kicker = "The Den · Invoices",
                        title = "Getting",
                        accentTail = "paid.",
                        trailing = {
                            HeaderCtas(
                                onNewInvoice = { quoteMode = false; showComposer = true },
                                onNewQuote = { quoteMode = true; showComposer = true },
                            )
                        },
                    )
                }

                // Loud confirmation for a per-row action (reminder / draft sent /
                // receipt). Errors render in the Error banner below via [error].
                actionMessage?.let { msg ->
                    item {
                        AuntieBanner(
                            tone = AuntieBannerTone.Success,
                            title = msg,
                            icon = Lucide.ReceiptText,
                            onDismiss = { viewModel.clearInvoiceActionMessage() },
                        ) {}
                    }
                }

                when {
                    // Fail loud: surface the VM stream error as a dismiss-less Error banner.
                    error != null -> item {
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            title = "Couldn't load invoices",
                            icon = Lucide.ReceiptText,
                        ) {
                            Text(
                                error ?: "",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }

                    isLoading && invoices.isEmpty() -> item {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            repeat(4) { ShimmerCard(height = 96) }
                        }
                    }

                    invoices.isEmpty() -> item { EmptyState() }

                    else -> {
                        val sorted = invoices.sortedByDescending {
                            isoDatePrefixOrNull(it.date) ?: isoDatePrefixOrNull(it.dueDate) ?: ""
                        }
                        val households = householdFacets(invoices)
                        if (household !in households) household = ALL_HOUSEHOLDS
                        val visible = sorted.filter {
                            matchesFilter(it, filter, todayIso) &&
                                matchesQuery(it, query) &&
                                matchesHouseholdFacet(it, household)
                        }

                        item { SummaryStrip(invoices, todayIso) }

                        item {
                            FilterRow(
                                selected = filter,
                                onSelect = { filter = it },
                                query = query,
                                onQueryChange = { query = it },
                                households = households,
                                household = household,
                                onHousehold = { household = it },
                            )
                        }

                        item {
                            DenPanel(
                                title = "Invoices",
                                subtitle = "${visible.size} of ${invoices.size} shown. Tap a row to open the invoice.",
                            ) {
                                if (visible.isEmpty()) {
                                    AuntieEmptyState(
                                        title = "Nothing matches that filter",
                                        message = "Try a different tab or clear your search.",
                                        icon = Lucide.ReceiptText,
                                        compact = true,
                                    )
                                } else {
                                    InvoiceList(
                                        invoices = visible,
                                        todayIso = todayIso,
                                        onOpenDetail = onOpenDetail,
                                        onReceipt = { viewModel.generateReceipt(it.id) },
                                        onSendReminder = { viewModel.sendInvoiceReminder(it.id) },
                                        onSendDraft = { viewModel.reviewAndSendDraftInvoice(it) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    NewInvoiceDialog(
        visible = showComposer,
        kinfolk = kinfolk,
        quoteMode = quoteMode,
        initialKinfolkId = quoteSeedKinfolkId,
        onDismiss = { showComposer = false; quoteSeedKinfolkId = "" },
        onConfirm = { invoice, sendToKinfolk ->
            showComposer = false
            if (quoteMode) {
                viewModel.createQuote(invoice, sendToKinfolk)
            } else {
                viewModel.createInvoice(invoice)
            }
        },
    )
}

/**
 * Header CTAs: "New invoice" (createInvoice) and "New quote" (createQuote). Both
 * route through the shared composer dialog; the quote CTA flips it into quote mode.
 */
@Composable
private fun HeaderCtas(onNewInvoice: () -> Unit, onNewQuote: () -> Unit) {
    val c = AuntieTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
        GhostButton(label = "New quote", onClick = onNewQuote)
        PrimaryButton(
            label = "New invoice",
            onClick = onNewInvoice,
            leading = {
                Icon(
                    imageVector = Lucide.Plus,
                    contentDescription = null,
                    tint = c.background,
                    modifier = Modifier.height(16.dp),
                )
            },
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

    val worstOverdue = overdueInvoices.maxByOrNull { daysOverdue(it, todayIso) ?: 0 }
    val overdueCaption = when {
        worstOverdue == null -> "all clear"
        else -> {
            val who = worstOverdue.kinfolkName.ifBlank { worstOverdue.client.ifBlank { "a kinfolk" } }
            val days = daysOverdue(worstOverdue, todayIso)
            if (days != null) "$who, $days days past" else who
        }
    }

    // Stacked vertically for phone width (web lays these three across a row).
    Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
        StatCard(
            label = "Outstanding",
            value = formatMoney(outstandingTotal),
            trend = "across ${outstanding.size} invoice${if (outstanding.size == 1) "" else "s"}",
            tone = if (outstandingTotal > 0.0) AuntieStatusTone.Orange else AuntieStatusTone.Success,
            feature = outstandingTotal > 0.0,
            modifier = Modifier.fillMaxWidth(),
        )
        // Honest, computable "Billed total": there is no paidDate on Invoice, so a
        // month-bounded "paid this month" figure can't be derived without faking it.
        StatCard(
            label = "Billed total",
            value = formatMoney(billedTotal),
            trend = "all invoices on the books",
            tone = AuntieStatusTone.Teal,
            modifier = Modifier.fillMaxWidth(),
        )
        StatCard(
            label = "Overdue",
            value = "$overdueCount",
            trend = overdueCaption,
            tone = if (overdueCount > 0) AuntieStatusTone.Error else AuntieStatusTone.Muted,
            feature = overdueCount > 0,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

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
    // Stacked vertically for phone width: chips, then household facet, then search.
    Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
        Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
            InvoiceFilter.entries.forEach { f ->
                AuntieChip(
                    selected = selected == f,
                    onClick = { onSelect(f) },
                    label = f.label,
                )
            }
        }
        // Kinfolk facet (spec 16.2): pin the list to one household. Shown only when
        // there is more than one household to choose between.
        if (households.size > 2) {
            AuntieDropdownField(
                value = household,
                options = households,
                onSelect = onHousehold,
                displayText = { it.name },
                label = "Household",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        AuntieSearchField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = "Search invoice #, kinfolk, or amount...",
            onClear = { onQueryChange("") },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun InvoiceList(
    invoices: List<Invoice>,
    todayIso: String,
    onOpenDetail: (invoiceId: String) -> Unit,
    onReceipt: (Invoice) -> Unit,
    onSendReminder: (Invoice) -> Unit,
    onSendDraft: (Invoice) -> Unit,
) {
    Column {
        invoices.forEachIndexed { idx, invoice ->
            InvoiceRow(
                invoice,
                todayIso = todayIso,
                onOpenDetail = onOpenDetail,
                onReceipt = onReceipt,
                onSendReminder = onSendReminder,
                onSendDraft = onSendDraft,
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
    onOpenDetail: (invoiceId: String) -> Unit,
    onReceipt: (Invoice) -> Unit,
    onSendReminder: (Invoice) -> Unit,
    onSendDraft: (Invoice) -> Unit,
) {
    val c = AuntieTheme.colors
    val state = invoiceStateOf(invoice)
    val quote = state == InvoiceState.QUOTE
    val draft = state == InvoiceState.DRAFT
    val overdue = invoiceIsOverdue(invoice, todayIso)
    val unpaid = state == InvoiceState.OPEN

    // Every chip is a positive read of the enumerated state. The old `else ->
    // "Paid"` fallback labelled a credit, a cancelled invoice, and a $0 row as
    // PAID, which is the same negation defect the gating below fixes.
    val (statusLabel, statusTone) = if (overdue) {
        "Overdue" to AuntieStatusTone.Error
    } else {
        when (state) {
            InvoiceState.QUOTE -> "Quote" to AuntieStatusTone.Purple
            InvoiceState.DRAFT -> "Draft" to AuntieStatusTone.Muted
            InvoiceState.CANCELLED -> "Cancelled" to AuntieStatusTone.Muted
            InvoiceState.CREDIT -> "Credit" to AuntieStatusTone.Teal
            InvoiceState.ZERO -> "Zero" to AuntieStatusTone.Muted
            InvoiceState.OPEN -> "Unpaid" to AuntieStatusTone.Orange
            InvoiceState.PAID -> "Paid" to AuntieStatusTone.Success
        }
    }
    val amountColor = statusTone.color(c)

    // Stacked vertically for phone width: identity row up top, then the meta line,
    // then amount + status + action. (The web spec lays all four across one row.)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenDetail(invoice.id) }
            .padding(
                horizontal = AuntieTheme.dims.space2,
                vertical = AuntieTheme.dims.space4,
            ),
        verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
    ) {
        // Top: invoice number (mono) + kinfolk avatar + name.
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
        ) {
            AuntieAvatar(
                initials = invoice.kinfolkName.ifBlank { invoice.client },
                gradientSeed = invoice.kinfolkId.ifBlank { invoice.kinfolkName },
                size = 40.dp,
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = invoice.kinfolkName.ifBlank { invoice.client.ifBlank { "Unknown" } },
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                val secondary = invoice.client.takeIf { it.isNotBlank() && it != invoice.kinfolkName }
                if (secondary != null) {
                    Text(secondary, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = "invoice",
                    style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                    color = c.textDim,
                )
                Text(
                    text = "#${invoice.invoiceNumber.ifBlank { "(none)" }}",
                    style = AuntieTheme.typography.mono.copy(fontWeight = FontWeight.Medium),
                    color = c.textPrimary,
                )
            }
        }

        // Meta: humanized due / paid line (+ days overdue) + linked visits.
        val days = daysOverdue(invoice, todayIso)
        val line1 = when {
            quote -> "quote"
            draft -> "draft"
            overdue && days != null -> "$days days overdue"
            invoice.dueDate.isNotBlank() && unpaid -> "due ${humanizeDate(invoice.dueDate)}"
            invoice.date.isNotBlank() -> "paid ${humanizeDate(invoice.date)}"
            invoice.dueDate.isNotBlank() -> "due ${humanizeDate(invoice.dueDate)}"
            else -> "no date"
        }
        Text(
            line1,
            style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
            color = if (overdue) c.error else c.textDim,
        )
        val visitCount = invoice.sessionIds.size
        if (visitCount > 0) {
            Text(
                text = "linked to $visitCount visit${if (visitCount == 1) "" else "s"}",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                color = c.accent,
            )
        }

        // Bottom: amount + status pill + action.
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
        ) {
            Text(
                text = formatMoney(invoice.total),
                style = AuntieTheme.typography.titleLarge,
                color = amountColor,
            )
            AuntieStatusPill(label = statusLabel, tone = statusTone, mono = true)
            Spacer(Modifier.weight(1f))
            RowAction(
                actions = invoiceActionsFor(state),
                onReceipt = { onReceipt(invoice) },
                onSendReminder = { onSendReminder(invoice) },
                onSendDraft = { onSendDraft(invoice) },
            )
        }
    }
}

/**
 * Per-row action button, chosen from the SHARED action set (domain/
 * InvoiceActions.kt) so a row can never offer an action the detail screen
 * withholds, or the reverse. Every variant fires a live callable: a draft
 * reviews and sends (reviewAndSendDraftInvoice), an unpaid invoice sends an
 * on-demand reminder (sendInvoiceReminder), and a paid one generates a receipt
 * (generateReceipt). No control is a dead button.
 *
 * The old version branched on three booleans with `else -> Receipt`, so a
 * quote was the only row without an action and everything unclassified, a
 * credit, a cancelled invoice, a $0 row, got a Receipt button it had no
 * business offering. A state with no available action now renders nothing;
 * the row itself is still tappable through to the detail screen.
 *
 * RECORD_PAYMENT is intentionally absent here: recording a payment needs the
 * amount/method/reference dialog, which lives on the detail screen.
 */
@Composable
private fun RowAction(
    actions: List<InvoiceAction>,
    onReceipt: () -> Unit,
    onSendReminder: () -> Unit,
    onSendDraft: () -> Unit,
) {
    val c = AuntieTheme.colors
    when {
        InvoiceAction.REVIEW_AND_SEND in actions ->
            PrimaryButton(label = "Review & send", onClick = onSendDraft)
        InvoiceAction.SEND_REMINDER in actions -> PrimaryButton(
            label = "Send reminder",
            onClick = onSendReminder,
            leading = {
                Icon(
                    imageVector = Lucide.Bell,
                    contentDescription = null,
                    tint = c.background,
                    modifier = Modifier.height(14.dp),
                )
            },
        )
        InvoiceAction.GENERATE_RECEIPT in actions -> GhostButton(label = "Receipt", onClick = onReceipt)
        // Quote, cancelled, credit, zero: nothing to offer from a list row.
        else -> Unit
    }
}

@Composable
private fun EmptyState() {
    AuntieEmptyState(
        title = "No invoices on the books yet",
        message = "Tap New invoice up top to create the first one. Outstanding sit on top, paid tuck beneath.",
        icon = Lucide.ReceiptText,
    )
}
