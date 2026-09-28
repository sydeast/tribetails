package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.MAX_GIVE_CREDIT_REASON_LENGTH
import com.tribetails.auntieos.web.data.OpenInvoiceDto
import com.tribetails.auntieos.web.data.UnappliedDecision
import com.tribetails.auntieos.web.data.UnappliedDecisionOutcome
import com.tribetails.auntieos.web.data.UnappliedPaymentDto
import com.tribetails.auntieos.web.data.UnappliedPaymentsLoad
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.datetime.TimeZone

/*
 * #1003: "Payments needing a decision", a sub-section of the household's
 * Account credit panel, and the Decide dialog. The wording matches the admin
 * web and Android clients.
 */

// ---- Pure text and rules (commonTest covers every one) ----

private fun invoiceLabel(number: String): String = number.ifBlank { "an unnumbered invoice" }

/** "$25.00 card payment on invoice INV-1042". */
fun unappliedPaymentLine(p: UnappliedPaymentDto): String =
    "${creditUsd(p.amountCents)} card payment on invoice ${invoiceLabel(p.invoiceNumber)}"

/** "Sep 27, 2026. Not applied because the invoice was already marked paid." */
fun unappliedPaymentDetailLine(p: UnappliedPaymentDto, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    val date = if (p.receivedAtMs > 0L) creditDate(p.receivedAtMs, zone) else "Date not recorded"
    val reason = p.reason.trim().trimEnd('.')
    return if (reason.isEmpty()) "$date. Not applied." else "$date. Not applied because $reason."
}

/** The dialog's lead line. */
fun decideLeadLine(p: UnappliedPaymentDto): String =
    "Card payment of ${creditUsd(p.amountCents)} on invoice ${invoiceLabel(p.invoiceNumber)}. " +
        "There are no refunds. Anything you do not credit or apply stays recorded on the payment."

/** One picker row: "INV-1050, $40.00 due". */
fun openInvoiceOptionLabel(i: OpenInvoiceDto): String =
    "${invoiceLabel(i.invoiceNumber)}, ${creditUsd(i.amountDueCents)} due"

const val DECIDE_NO_OPEN_INVOICES = "No open invoices for this household."
const val UNAPPLIED_EMPTY_FROM_NOTICE = "No card payments are waiting for a decision."
const val UNAPPLIED_LOAD_FAILED = "Could not load payments needing a decision."
const val UNAPPLIED_TITLE = "Payments needing a decision"
const val DECIDE_TITLE = "Decide what this payment becomes"

const val DECIDE_ERR_OVER = "The credit and the applied amount add up to more than this payment."
const val DECIDE_ERR_REASON = "Enter a reason for the credit."
const val DECIDE_ERR_INVOICE = "Choose an invoice for the applied amount."
const val DECIDE_ERR_AMOUNT = "Enter an amount in dollars, like 12.50."

/** "That invoice owes only $40.00." */
fun decideInvoiceOwesOnly(amountDueCents: Long): String = "That invoice owes only ${creditUsd(amountDueCents)}."

/** Empty means 0; otherwise a dollar amount with at most 2 decimals, not negative. */
fun parseDecisionDollars(raw: String): Long? {
    val s = raw.trim()
    if (s.isEmpty()) return 0L
    if (s.startsWith("-")) return null
    return parseCreditDollarsToCents(s)
}

/** "Credit $10.00, apply $15.00, keep $0.00." Unparseable fields count as 0 here; the refusal says why. */
fun decisionSummaryLine(paymentCents: Long, creditText: String, applyText: String): String {
    val credit = parseDecisionDollars(creditText) ?: 0L
    val apply = parseDecisionDollars(applyText) ?: 0L
    val keep = (paymentCents - credit - apply).coerceAtLeast(0L)
    return "Credit ${creditUsd(credit)}, apply ${creditUsd(apply)}, keep ${creditUsd(keep)}."
}

/** What the Decide form came to. */
sealed class DecisionForm {
    data class Ready(val decision: UnappliedDecision) : DecisionForm()
    data class Invalid(val message: String) : DecisionForm()
}

/**
 * Checks the form before any call, in this order: both amounts parse, the sum
 * fits the payment, a credit has a reason, an applied amount has an invoice,
 * and the invoice owes at least that much. The server checks all of it again.
 * The request is built from these fields only.
 */
fun parseDecisionForm(
    payment: UnappliedPaymentDto,
    creditText: String,
    reasonText: String,
    invoice: OpenInvoiceDto?,
    applyText: String,
): DecisionForm {
    val credit = parseDecisionDollars(creditText) ?: return DecisionForm.Invalid(DECIDE_ERR_AMOUNT)
    val apply = parseDecisionDollars(applyText) ?: return DecisionForm.Invalid(DECIDE_ERR_AMOUNT)
    if (credit + apply > payment.amountCents) return DecisionForm.Invalid(DECIDE_ERR_OVER)
    val reason = reasonText.trim()
    if (credit > 0L && reason.isEmpty()) return DecisionForm.Invalid(DECIDE_ERR_REASON)
    if (apply > 0L && invoice == null) return DecisionForm.Invalid(DECIDE_ERR_INVOICE)
    if (invoice != null && apply > invoice.amountDueCents) {
        return DecisionForm.Invalid(decideInvoiceOwesOnly(invoice.amountDueCents))
    }
    return DecisionForm.Ready(
        UnappliedDecision(
            paymentId = payment.paymentId,
            creditCents = credit,
            creditReason = if (credit > 0L) reason else "",
            applyInvoiceId = if (apply > 0L) invoice?.invoiceId.orEmpty() else "",
            applyCents = apply,
        ),
    )
}

/** The save button's label. */
fun decisionSaveLabel(saving: Boolean): String = if (saving) "Saving..." else "Save decision"

/** The dialog cannot be closed while the call is in flight: its answer has to land somewhere. */
fun decideDialogCanDismiss(saving: Boolean): Boolean = !saving

/**
 * The note after a saved decision, built only from the server's answer:
 * "Decision saved. $10.00 to account credit (balance now $37.00). $15.00 on
 * invoice INV-1050 (paid in full). $0.00 kept on the payment."
 */
fun decisionResultText(o: UnappliedDecisionOutcome): String {
    val parts = mutableListOf("Decision saved.")
    if (o.creditedCents > 0L) {
        parts += "${creditUsd(o.creditedCents)} to account credit (balance now ${creditUsd(o.newAccountBalanceCents)})."
    }
    if (o.appliedCents > 0L) {
        val state = if (o.appliedInvoiceState == "settled") "paid in full"
        else "${creditUsd(o.appliedInvoiceAmountDueCents)} still due"
        parts += "${creditUsd(o.appliedCents)} on invoice ${invoiceLabel(o.appliedInvoiceNumber)} ($state)."
    }
    parts += "${creditUsd(o.keptCents)} kept on the payment."
    return parts.joinToString(" ")
}

/** What the sub-section shows. */
sealed class UnappliedSectionView {
    object Hidden : UnappliedSectionView()
    object Empty : UnappliedSectionView()
    object Failed : UnappliedSectionView()
    data class Rows(val payments: List<UnappliedPaymentDto>) : UnappliedSectionView()
}

/**
 * Hidden while loading, when refused, and when nothing waits (unless the
 * screen was opened from the notice, then the empty line shows).
 */
fun unappliedSectionView(load: UnappliedPaymentsLoad?, openedFromNotice: Boolean): UnappliedSectionView =
    when (load) {
        null, UnappliedPaymentsLoad.Hidden -> UnappliedSectionView.Hidden
        is UnappliedPaymentsLoad.Failed -> UnappliedSectionView.Failed
        is UnappliedPaymentsLoad.Loaded ->
            if (load.list.payments.isNotEmpty()) UnappliedSectionView.Rows(load.list.payments)
            else if (openedFromNotice) UnappliedSectionView.Empty
            else UnappliedSectionView.Hidden
    }

/** The payment the notice points at, when it is in the loaded list. */
fun paymentToOpenFromNotice(load: UnappliedPaymentsLoad?, paymentId: String?): UnappliedPaymentDto? {
    if (paymentId.isNullOrBlank()) return null
    return (load as? UnappliedPaymentsLoad.Loaded)?.list?.payments?.firstOrNull { it.paymentId == paymentId }
}

// ---- Composables ----

/** The sub-section inside the Account credit panel. [resultNote] shows whether or not rows remain. */
@Composable
internal fun UnappliedPaymentsSection(
    load: UnappliedPaymentsLoad?,
    openedFromNotice: Boolean,
    resultNote: String?,
    enabled: Boolean,
    onRetry: () -> Unit,
    onDecide: (UnappliedPaymentDto) -> Unit,
) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val view = unappliedSectionView(load, openedFromNotice)
    if (resultNote == null && view == UnappliedSectionView.Hidden) return
    Column(modifier = Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (resultNote != null) {
            Text(resultNote, style = t.bodySmall, color = c.textPrimary)
        }
        if (view == UnappliedSectionView.Hidden) return@Column
        Text(UNAPPLIED_TITLE, style = t.labelSmall, color = c.textDim)
        when (view) {
            UnappliedSectionView.Hidden -> Unit
            UnappliedSectionView.Empty -> Text(UNAPPLIED_EMPTY_FROM_NOTICE, style = t.bodySmall, color = c.textDim)
            UnappliedSectionView.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(UNAPPLIED_LOAD_FAILED, style = t.bodySmall, color = c.error)
                GhostButton(label = "Retry", onClick = onRetry)
            }
            is UnappliedSectionView.Rows -> view.payments.forEach { p ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(unappliedPaymentLine(p), style = t.bodyMedium, color = c.textPrimary)
                        Text(unappliedPaymentDetailLine(p), style = t.bodySmall, color = c.textDim)
                    }
                    Spacer(Modifier.width(8.dp))
                    GhostButton(label = "Decide", enabled = enabled, onClick = { onDecide(p) })
                }
            }
        }
    }
}

/** The Decide dialog. Refusals show inline and disable Save; not dismissable while saving. */
@Composable
internal fun DecideUnappliedPaymentDialog(
    payment: UnappliedPaymentDto?,
    openInvoices: List<OpenInvoiceDto>,
    saving: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSubmit: (UnappliedDecision) -> Unit,
) {
    val p = payment ?: return
    var credit by remember(p.paymentId) { mutableStateOf("") }
    var reason by remember(p.paymentId) { mutableStateOf("") }
    var invoice by remember(p.paymentId) { mutableStateOf<OpenInvoiceDto?>(null) }
    var apply by remember(p.paymentId) { mutableStateOf("") }
    val form = parseDecisionForm(p, credit, reason, invoice, apply)
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    AuntieDialog(
        visible = true,
        title = DECIDE_TITLE,
        onDismiss = { if (decideDialogCanDismiss(saving)) onDismiss() },
        maxWidth = 500.dp,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = decideDialogCanDismiss(saving))
            Spacer(Modifier.width(8.dp))
            PrimaryButton(
                label = decisionSaveLabel(saving),
                enabled = !saving && form is DecisionForm.Ready,
                loading = saving,
                onClick = { (form as? DecisionForm.Ready)?.let { onSubmit(it.decision) } },
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (error != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Not saved",
                    icon = Lucide.CircleAlert,
                    body = { Text(error, style = t.bodySmall, color = c.textDim) },
                )
            }
            Text(decideLeadLine(p), style = t.bodyMedium, color = c.textPrimary)
            BottomBorderField(
                credit, { credit = it },
                label = "Account credit (\$)",
                placeholder = "0.00",
                keyboardType = KeyboardType.Decimal,
                enabled = !saving,
                modifier = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                reason, { if (it.length <= MAX_GIVE_CREDIT_REASON_LENGTH) reason = it },
                label = "Reason for the credit",
                enabled = !saving,
                singleLine = false,
                modifier = Modifier.fillMaxWidth(),
            )
            if (openInvoices.isEmpty()) {
                Text(DECIDE_NO_OPEN_INVOICES, style = t.bodySmall, color = c.textDim)
            } else {
                AuntieSelectField(
                    label = "Apply to invoice",
                    options = listOf<OpenInvoiceDto?>(null) + openInvoices,
                    selected = invoice,
                    onSelect = {
                        invoice = it
                        if (it == null) apply = ""
                    },
                    optionLabel = { it?.let(::openInvoiceOptionLabel) ?: "None" },
                    enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                )
                BottomBorderField(
                    apply, { apply = it },
                    label = "Amount to apply (\$)",
                    placeholder = "0.00",
                    keyboardType = KeyboardType.Decimal,
                    enabled = !saving && invoice != null,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Text(decisionSummaryLine(p.amountCents, credit, apply), style = t.bodySmall, color = c.textPrimary)
            if (form is DecisionForm.Invalid) {
                Text(form.message, style = t.bodySmall, color = c.error)
            }
        }
    }
}
