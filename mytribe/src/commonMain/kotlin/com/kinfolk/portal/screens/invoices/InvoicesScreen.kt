package com.kinfolk.portal.screens.invoices

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinCalendarBadge
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinTintPill
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.calendarBadgeFromLabel
import com.kinfolk.portal.util.formatUsd

/**
 * Invoices list, styled per ui-ideas/mytribe-invoices-2026-05-31.html: serif
 * page head, teal-to-purple Account Balance hero, glass section cards (Open
 * Invoices / Paid History) with calendar-tile rows and tinted status chips,
 * and the Credits aside. Wide (>= 880dp, shell breakpoint): two columns
 * 1.6fr/1fr like Home; narrow: one column.
 *
 * Detail selection stays lifted into nav: tapping a card emits
 * [onOpenInvoice] (id) and the host routes to InvoiceDetailRoute. The screen
 * still owns its list + pay/redeem state via the shared controller, which the
 * detail destination reuses so pay/redeem side-effects survive across nav.
 */
@Composable
fun InvoicesScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onOpenInvoice: (String) -> Unit = {},
    controller: InvoicesController = rememberInvoicesController(kinfolkId, portalApi),
) {
    val type = LocalKinfolkTypography.current
    val data = controller.data
    val error = controller.error
    val statusBanner = controller.statusBanner

    LaunchedEffect(kinfolkId) { controller.reload() }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            // Page head (mockup hero-greet): mono kicker + serif title.
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
                Text("BILLING", style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange))
                Spacer(Modifier.height(KinfolkSpacing.xs))
                Text(
                    buildAnnotatedString {
                        append("Your ")
                        withStyle(SpanStyle(color = KinfolkBrand.PackPink)) { append("invoices") }
                        append(" and balance.")
                    },
                    style = type.heritageDisplay.copy(fontWeight = FontWeight.Normal),
                )
            }

            // Account balance hero — always visible when positive.
            if (data != null) {
                AccountBalanceHero(data.accountBalanceCents)
            }

            val mainColumn: @Composable () -> Unit = {
                OpenInvoicesCard(
                    data = controller.data,
                    error = error,
                    payingId = controller.paying,
                    onPay = { controller.startPay(it) },
                    onOpenInvoice = onOpenInvoice,
                )
                PaidHistoryCard(
                    data = controller.data,
                    error = error,
                    onOpenInvoice = onOpenInvoice,
                )
            }

            val asideColumn: @Composable () -> Unit = {
                if (data?.credits?.isNotEmpty() == true) {
                    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
                        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                            SectLabel("Credits")
                            data!!.credits.forEachIndexed { i, inv ->
                                if (i > 0) RowDivider()
                                CreditEntry(
                                    invoice = inv,
                                    redeeming = controller.redeeming == inv.id,
                                    onRedeem = { tgt -> controller.startRedeem(inv, tgt) },
                                    onClick = { onOpenInvoice(inv.id) },
                                )
                            }
                            if (statusBanner != null) {
                                Text(statusBanner, style = type.sansLabel.copy(color = KinfolkBrand.KinTeal))
                            }
                        }
                    }
                }
            }

            if (wide) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(modifier = Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        mainColumn()
                    }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        asideColumn()
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                ) {
                    mainColumn()
                    asideColumn()
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

// ---- Hero ----

/** Teal-to-purple balance hero (mockup `.balance`). Hidden when zero. */
@Composable
private fun AccountBalanceHero(balanceCents: Long) {
    val type = LocalKinfolkTypography.current
    if (balanceCents <= 0L) return
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KinfolkSpacing.l)
            .clip(KinfolkShapes.card)
            .background(KinfolkGradients.tealToPurple)
            .padding(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Account Balance", style = type.sansMeta.copy(color = Color.White.copy(alpha = 0.92f)))
            Text(
                formatCents(balanceCents),
                style = type.heritageDisplay.copy(color = Color.White, fontSize = 44.sp, fontWeight = FontWeight.Normal),
            )
            Text(
                "Available credit on your account. Applied automatically to next invoice.",
                style = type.sansBody.copy(color = Color.White.copy(alpha = 0.92f)),
            )
        }
    }
}

// ---- Section cards ----

@Composable
private fun OpenInvoicesCard(
    data: com.kinfolk.portal.portal.InvoicesResult?,
    error: String?,
    payingId: String?,
    onPay: (Invoice) -> Unit,
    onOpenInvoice: (String) -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Open Invoices")
            when {
                error != null -> CardEmpty(title = "Couldn't load invoices", message = error)
                data == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }
                data.open.isEmpty() -> CardEmpty(
                    title = "No open invoices",
                    message = "Quoted and pending invoices will appear here with payment options.",
                )
                else -> data.open.forEachIndexed { i, inv ->
                    if (i > 0) RowDivider()
                    OpenInvoiceRow(
                        invoice = inv,
                        paying = payingId == inv.id,
                        onPay = { onPay(inv) },
                        onClick = { onOpenInvoice(inv.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PaidHistoryCard(
    data: com.kinfolk.portal.portal.InvoicesResult?,
    error: String?,
    onOpenInvoice: (String) -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m), dim = true) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Paid History")
            when {
                data == null && error == null -> Spacer(Modifier.height(KinfolkSpacing.s))
                data?.paid.isNullOrEmpty() -> CardEmpty(
                    title = "No paid invoices yet",
                    message = "Past payments and receipts will appear here.",
                )
                else -> data!!.paid.forEachIndexed { i, inv ->
                    if (i > 0) RowDivider()
                    PaidInvoiceRow(invoice = inv, onClick = { onOpenInvoice(inv.id) })
                }
            }
        }
    }
}

// ---- Rows ----

@Composable
private fun OpenInvoiceRow(
    invoice: Invoice,
    paying: Boolean,
    onPay: () -> Unit,
    onClick: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.xs, vertical = KinfolkSpacing.s),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KinCalendarBadge(calendarBadgeFromLabel(invoice.dueDate), accent = KinfolkBrand.KinfolkOrange)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    invoice.client ?: "Invoice #${invoice.id}",
                    style = type.sansBody.copy(fontWeight = FontWeight.SemiBold),
                )
                // With no client name the title is already "Invoice #id" — don't
                // repeat it; the due date below carries the meta line.
                if (invoice.client != null) {
                    Text("Invoice #${invoice.id}", style = type.sansMeta)
                }
                Text("Due ${invoice.dueDate ?: "—"}", style = type.sansMeta)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                Text(formatUsd(invoice.amountDue), style = type.heritageTitle.copy(fontSize = 18.sp))
                StatusChip(invoice.status)
            }
        }
        KinButton(
            label = if (paying) "Opening checkout…" else "Pay ${formatUsd(invoice.amountDue)}",
            onClick = onPay,
            modifier = Modifier.fillMaxWidth(),
            enabled = !paying && invoice.amountDue > 0.0,
        )
    }
}

@Composable
private fun PaidInvoiceRow(invoice: Invoice, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.xs, vertical = KinfolkSpacing.s),
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KinCalendarBadge(calendarBadgeFromLabel(invoice.date), accent = KinfolkBrand.KinTeal)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                invoice.client ?: "Invoice #${invoice.id}",
                style = type.sansBody.copy(fontWeight = FontWeight.SemiBold),
            )
            // Same de-duplication as OpenInvoiceRow: the paid date is the meta.
            if (invoice.client != null) {
                Text("Invoice #${invoice.id}", style = type.sansMeta)
            }
            Text("Paid ${invoice.date ?: "—"}", style = type.sansMeta)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
            Text(formatUsd(invoice.total), style = type.heritageTitle.copy(fontSize = 18.sp))
            StatusChip(invoice.status)
        }
    }
}

@Composable
private fun CreditEntry(
    invoice: Invoice,
    redeeming: Boolean,
    onRedeem: (CreditTarget) -> Unit,
    onClick: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val cents = invoice.creditAmountCents ?: 0L
    val redeemed = invoice.creditRedeemedAtMs != null
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.xs, vertical = KinfolkSpacing.s),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    invoice.client ?: "Invoice #${invoice.id}",
                    style = type.sansBody.copy(fontWeight = FontWeight.SemiBold),
                )
                Text("Credit • Invoice #${invoice.id}", style = type.sansMeta)
            }
            KinTintPill(
                if (redeemed) "REDEEMED" else "CREDIT",
                if (redeemed) KinfolkBrand.FamilyPurple else KinfolkBrand.PackPink,
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Credit amount", style = type.sansLabel)
            Text(formatCents(cents), style = type.heritageTitle.copy(color = KinfolkBrand.KinTeal, fontSize = 18.sp))
        }
        if (redeemed) {
            val targetLabel = when (invoice.creditTarget) {
                CreditTarget.AccountBalance -> "Saved to Account Balance"
                CreditTarget.OriginalPaymentMethod -> "Returned to Original Payment Method"
                null -> "Redeemed"
            }
            Text(targetLabel, style = type.sansMeta.copy(color = KinfolkBrand.KinTeal))
        } else {
            KinButton(
                label = if (redeeming) "Working…" else "Save to Account Balance",
                onClick = { onRedeem(CreditTarget.AccountBalance) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !redeeming,
            )
            KinGhostButton(
                label = "Return to Original Payment Method",
                onClick = { onRedeem(CreditTarget.OriginalPaymentMethod) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !redeeming && !invoice.originalPaymentIntentId.isNullOrBlank(),
            )
            if (invoice.originalPaymentIntentId.isNullOrBlank()) {
                Text(
                    "Original card not on file. Only Account Balance is available.",
                    style = type.sansMeta,
                )
            }
        }
    }
}

// ---- Shared bits ----

/**
 * Friendly invoice status label shared by the list chips (uppercased there)
 * and the detail screen's Status row — never the raw enum name.
 */
internal fun invoiceStatusLabel(status: InvoiceStatus): String = when (status) {
    InvoiceStatus.Open -> "Pending"
    InvoiceStatus.Paid -> "Paid"
    InvoiceStatus.Draft -> "Draft"
    InvoiceStatus.Credit -> "Credit"
    InvoiceStatus.Cancelled -> "Cancelled"
}

@Composable
private fun StatusChip(status: InvoiceStatus) {
    val color = when (status) {
        InvoiceStatus.Open -> KinfolkBrand.KinfolkOrange
        InvoiceStatus.Paid -> KinfolkBrand.KinTeal
        InvoiceStatus.Draft -> KinfolkBrand.NavySoft
        InvoiceStatus.Credit -> KinfolkBrand.PackPink
        InvoiceStatus.Cancelled -> KinfolkBrand.SnuggleCoral
    }
    KinTintPill(invoiceStatusLabel(status).uppercase(), color)
}

@Composable
private fun SectLabel(text: String) {
    val type = LocalKinfolkTypography.current
    Text(text, style = type.sansMeta, modifier = Modifier.padding(bottom = KinfolkSpacing.xs))
}

@Composable
private fun RowDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KinfolkSpacing.xs)
            .height(1.dp)
            .background(KinfolkBrand.NavyHairline),
    )
}

/** In-card empty state (mockup `.empty`): centered serif title + muted note. */
@Composable
private fun CardEmpty(title: String, message: String) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text(title, style = type.heritageSection)
        Text(
            message,
            style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
            modifier = Modifier.padding(horizontal = KinfolkSpacing.m),
        )
    }
}

private fun formatCents(cents: Long): String = formatUsd(cents.toDouble() / 100.0)
