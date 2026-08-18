package com.kinfolk.portal.screens.invoices

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.CreditTarget
import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PayMethod
import com.kinfolk.portal.portal.PayMethodKind
import com.kinfolk.portal.portal.QuoteDecision
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.formatUsd
import com.kinfolk.portal.util.relativeTime

@Composable
fun InvoiceDetailScreen(
    familyName: String,
    invoice: Invoice,
    paying: Boolean = false,
    redeeming: Boolean = false,
    downloadingPdf: Boolean = false,
    /**
     * PR30: one CTA per configured processor, resolved off `getMyHome`'s
     * `payMethods`. Empty renders no payment row at all — same contract as
     * the web `PayOptions` component — so a caller with nothing configured
     * (or that hasn't loaded yet) never shows a broken action.
     */
    payMethods: List<PayMethod> = emptyList(),
    /** True while this household's answer to a quote is in flight (issue #385). */
    decidingQuote: Boolean = false,
    /** The server's refusal of that answer, shown on the quote panel itself. */
    quoteError: String? = null,
    onPayMethod: (PayMethod) -> Unit = {},
    /** `true` accepts the quote, `false` declines it. */
    onQuoteDecision: (Boolean) -> Unit = {},
    onRedeem: (CreditTarget) -> Unit = {},
    onDownloadPdf: () -> Unit = {},
    onBack: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val isCredit = invoice.status == InvoiceStatus.Credit
    // A proposal, not a bill. `quoteDecision` is what separates one still
    // waiting for an answer from one already answered: a DECLINED quote keeps
    // its `quote` status server-side (functions/src/portal/quoteDecision.ts),
    // and an ACCEPTED one is an open invoice by the time it reaches here.
    val isQuote = invoice.status == InvoiceStatus.Quote
    val awaitingDecision = isQuote && invoice.quoteDecision == null
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back to invoices",
                    tint = KinfolkBrand.Navy,
                )
            }
            Text("Invoice #${invoice.id}", style = type.heritageTitle)
        }
        GlassCard(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    val (label, amt) = when {
                        isCredit -> "Credit" to (invoice.creditAmountCents?.toDouble()?.div(100.0) ?: 0.0)
                        invoice.isPaid -> "Paid" to invoice.total
                        else -> "Amount Due" to invoice.amountDue
                    }
                    Text(label, style = type.sansLabel)
                    Text(formatUsd(amt), style = type.heritageDisplay)
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Total", style = type.sansLabel)
                    Text(formatUsd(invoice.total), style = type.sansBody)
                }
                Spacer(Modifier.height(KinfolkSpacing.xs))
                // Same friendly labels as the list's status chips (never enum names).
                DetailRow("Status", invoiceStatusLabel(invoice.status))
                DetailRow("Client", invoice.client)
                DetailRow("Date", invoice.date)
                DetailRow("Due Date", invoice.dueDate)
                DetailRow("Discount", invoice.discount)
                DetailRow("Terms", invoice.terms)
                DetailRow("Address", invoice.address)
                if (!invoice.paymentsHistory.isNullOrBlank()) {
                    Spacer(Modifier.height(KinfolkSpacing.s))
                    Text("Payment History", style = type.sansLabel)
                    Text(invoice.paymentsHistory, style = type.sansBody)
                }
            }
        }

        // Per-visit breakdown, only when the backend sent line items.
        val lineItems = invoice.lineItems
        if (!lineItems.isNullOrEmpty()) {
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("What this covers", style = type.sansLabel)
                    lineItems.forEach { item ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(item.label ?: "Visit", style = type.sansBody)
                                if (!item.dateIso.isNullOrBlank()) {
                                    Text(item.dateIso, style = type.sansMeta)
                                }
                            }
                            item.amountCents?.let { cents ->
                                Text(formatUsd(cents.toDouble() / 100.0), style = type.sansBody)
                            }
                        }
                    }
                }
            }
        }

        if (awaitingDecision) {
            QuoteDecisionPanel(
                dueDate = invoice.dueDate,
                deciding = decidingQuote,
                error = quoteError,
                onDecision = onQuoteDecision,
            )
        } else if (invoice.quoteDecision != null) {
            val decided = when (invoice.quoteDecision) {
                QuoteDecision.Accepted -> "You accepted this quote"
                QuoteDecision.Denied -> "You declined this quote"
            }
            val whenLabel = relativeTime(invoice.quoteDecidedAtMs).takeIf { it.isNotBlank() }
            Text(
                if (whenLabel != null) "$decided $whenLabel" else decided,
                style = type.sansLabel.copy(
                    color = if (invoice.quoteDecision == QuoteDecision.Accepted) KinfolkBrand.KinTeal else KinfolkBrand.Navy,
                ),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }
        if (isCredit && invoice.creditRedeemedAtMs == null) {
            CreditRedeemPanel(
                hasOriginalPi = !invoice.originalPaymentIntentId.isNullOrBlank(),
                redeeming = redeeming,
                onRedeem = onRedeem,
            )
        } else if (isCredit) {
            val targetLabel = when (invoice.creditTarget) {
                CreditTarget.AccountBalance -> "Saved to Account Balance"
                CreditTarget.OriginalPaymentMethod -> "Returned to Original Payment Method"
                null -> "Redeemed"
            }
            Text(
                targetLabel,
                style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        } else if (!isQuote && !invoice.isPaid && invoice.amountDue > 0.0) {
            PayOptions(
                methods = payMethods,
                amountDue = invoice.amountDue,
                paying = paying,
                onPayMethod = onPayMethod,
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
            )
        }

        // 16.2 LIVE: renders the invoice PDF server-side (getMyInvoicePdf) and
        // opens the returned download URL.
        KinGhostButton(
            label = if (downloadingPdf) "Preparing PDF…" else "Download PDF",
            onClick = onDownloadPdf,
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
            enabled = !downloadingPdf,
        )
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

/**
 * THE QUOTE PANEL (issue #385): the one place on this screen where the
 * household is asked a question rather than shown a figure.
 *
 * Both buttons go dead together while an answer is in flight, so a second tap
 * cannot send a second answer, and the refusal printed underneath is the
 * SERVER'S sentence, because it is the side that knows whether this quote expired or
 * was already answered from the web portal.
 */
@Composable
private fun QuoteDecisionPanel(
    dueDate: String?,
    deciding: Boolean,
    error: String?,
    onDecision: (Boolean) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("This is a quote", style = type.heritageTitle)
            Text(
                "Nothing has been billed yet. Accept it and it becomes an invoice you can pay. " +
                    "Decline it and your Auntie will know you have passed on it." +
                    if (!dueDate.isNullOrBlank()) " This quote is good through $dueDate." else "",
                style = type.sansBody,
            )
            KinButton(
                label = if (deciding) "Working…" else "Accept quote",
                onClick = { onDecision(true) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !deciding,
            )
            KinGhostButton(
                label = "Decline",
                onClick = { onDecision(false) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !deciding,
            )
            if (!error.isNullOrBlank()) {
                Text(error, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
            }
        }
    }
}
@Composable
private fun CreditRedeemPanel(
    hasOriginalPi: Boolean,
    redeeming: Boolean,
    onRedeem: (CreditTarget) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Redeem Credit", style = type.heritageTitle)
            Text(
                "Choose how you'd like to receive this credit. Account Balance applies to your next invoice automatically.",
                style = type.sansBody,
            )
            Button(
                onClick = { onRedeem(CreditTarget.AccountBalance) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = KinfolkBrand.KinTeal,
                    contentColor = Color.White,
                ),
                enabled = !redeeming,
            ) { Text(if (redeeming) "Working…" else "Save to Account Balance") }
            KinGhostButton(
                label = "Return to Original Payment Method",
                onClick = { onRedeem(CreditTarget.OriginalPaymentMethod) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !redeeming && hasOriginalPi,
            )
            if (!hasOriginalPi) {
                Text(
                    "Original card not on file. Only Account Balance is available.",
                    style = type.sansMeta,
                )
            }
        }
    }
}

/**
 * PR30: one CTA per configured payment processor. `Checkout` (Stripe) is the
 * existing pay flow, styled the same [KinButton] the old single Pay button
 * used; `Link` (Venmo/PayPal/Cash App) is [KinGhostButton] plus a caption
 * stating the amount to send — a link method cannot be handed an amount, so
 * without the caption a household guesses and the operator reconciles the
 * mismatch by hand. Mirrors the web `PayOptions` component's contract:
 * renders nothing for an empty `methods` list rather than a broken row.
 */
@Composable
private fun PayOptions(
    methods: List<PayMethod>,
    amountDue: Double,
    paying: Boolean,
    onPayMethod: (PayMethod) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (methods.isEmpty()) return
    val type = LocalKinfolkTypography.current
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
        for (method in methods) {
            when (method.kind) {
                PayMethodKind.Checkout -> KinButton(
                    label = if (paying) "Opening checkout…" else method.label,
                    onClick = { onPayMethod(method) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !paying,
                )
                PayMethodKind.Link -> {
                    KinGhostButton(
                        label = method.label,
                        onClick = { onPayMethod(method) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "Send ${formatUsd(amountDue)}, then let your Auntie know it’s on its way.",
                        style = type.sansMeta,
                    )
                }
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String?) {
    if (value.isNullOrBlank()) return
    val type = LocalKinfolkTypography.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = type.sansLabel)
        Text(value, style = type.sansBody)
    }
}
