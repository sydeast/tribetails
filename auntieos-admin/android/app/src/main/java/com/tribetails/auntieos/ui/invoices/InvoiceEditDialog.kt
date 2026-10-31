package com.tribetails.auntieos.ui.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.domain.formatCents
import com.tribetails.auntieos.domain.formatQty
import com.tribetails.auntieos.domain.lineAmountCents
import com.tribetails.auntieos.domain.parseDollarsToCents
import com.tribetails.auntieos.domain.parseQty
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/** What the running total leaves out, or null when every row is readable. */
internal fun invoiceEditPendingCopy(unreadable: Int): String? = when (unreadable) {
    0 -> null
    1 -> "This total leaves out 1 line that still needs a quantity and a unit price."
    else -> "This total leaves out $unreadable lines that still need a quantity and a unit price."
}

/** "2 x $25.00, less $5.00" for a line shown read-only. */
internal fun invoiceEditLineSummary(line: InvoiceEditLine): String {
    val qty = parseQty(line.qtyText)
    val unit = parseDollarsToCents(line.unitText)
    if (qty == null || unit == null) return "${line.qtyText} x ${line.unitText}"
    val discount = if (line.discountText.isBlank()) 0L else parseDollarsToCents(line.discountText) ?: 0L
    return buildString {
        append(formatQty(qty))
        append(" x ")
        append(formatCents(unit))
        if (discount > 0L) append(", less ").append(formatCents(discount))
    }
}

/**
 * The invoice editor (#1174), the web edit form on Android: number, date, due
 * date, terms, line items and the whole-invoice discount, saved through
 * `updateInvoice`.
 *
 * Under a `metadataOnly` scope the money is SHOWN, read-only, under the same
 * "Money is locked" banner web shows; the four metadata fields stay editable.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun InvoiceEditDialog(
    draft: InvoiceEditDraft,
    error: String?,
    saving: Boolean,
    onChange: (InvoiceEditDraft) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
    onOpenVisit: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val enabled = !saving
    AuntieDialog(
        visible = true,
        title = "Edit invoice",
        onDismiss = onDismiss,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = enabled)
            PrimaryButton(
                label = if (saving) "Saving…" else "Save changes",
                onClick = onSave,
                loading = saving,
                enabled = enabled,
            )
        },
    ) {
        if (error != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't save") {
                Text(error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        if (!draft.moneyEditable) {
            AuntieBanner(tone = AuntieBannerTone.Warning, title = "Money is locked") {
                Text(
                    "A payment has already been recorded against this invoice, so its line items and " +
                        "discounts cannot change. The number, dates and terms can still be corrected.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }

        AuntieField(
            value = draft.invoiceNumber,
            onValueChange = { onChange(draft.copy(invoiceNumber = it)) },
            label = "Invoice number",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieField(
                value = draft.date,
                onValueChange = { onChange(draft.copy(date = it)) },
                label = "Date",
                placeholder = "YYYY-MM-DD",
                enabled = enabled,
                modifier = Modifier.weight(1f),
            )
            AuntieField(
                value = draft.dueDate,
                onValueChange = { onChange(draft.copy(dueDate = it)) },
                label = "Due date",
                placeholder = "YYYY-MM-DD",
                enabled = enabled,
                modifier = Modifier.weight(1f),
            )
        }
        AuntieField(
            value = draft.terms,
            onValueChange = { onChange(draft.copy(terms = it)) },
            label = "Terms",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )

        Text("Line items", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        if (draft.moneyEditable) {
            EditableLines(draft, enabled, onChange, onOpenVisit)
        } else {
            LockedLines(draft)
        }
    }
}

/** The money, read-only, for a `metadataOnly` invoice. Shown, never hidden. */
@Composable
private fun LockedLines(draft: InvoiceEditDraft) {
    val c = AuntieTheme.colors
    if (!draft.wasItemized) {
        Text(
            "No itemized breakdown. This invoice's total was entered directly.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    } else if (draft.lines.isEmpty()) {
        Text(
            "Itemized as billing nothing: there is a breakdown, and it is empty.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    }
    draft.lines.forEach { line ->
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                Text(line.description.ifBlank { "no description" }, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                Text(invoiceEditLineSummary(line), style = AuntieTheme.typography.labelSmall, color = c.textDim)
            }
        }
    }
    if (draft.invoiceDiscountText.isNotBlank()) {
        Text(
            "Invoice discount: ${parseDollarsToCents(draft.invoiceDiscountText)?.let(::formatCents) ?: draft.invoiceDiscountText}",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditableLines(
    draft: InvoiceEditDraft,
    enabled: Boolean,
    onChange: (InvoiceEditDraft) -> Unit,
    onOpenVisit: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val lines = draft.lines
    fun setLines(next: List<InvoiceEditLine>) = onChange(draft.copy(lines = next))

    if (lines.isEmpty()) {
        Text(
            // The un-itemized guard, said out loud: an invoice that never had
            // lines keeps its typed total when saved with none, while one that
            // had lines and now has none is itemized as billing nothing.
            if (draft.wasItemized) {
                "No line items. Saving like this bills nothing."
            } else {
                "No line items yet. Add one to itemize this invoice, or leave it empty to keep the total as entered."
            },
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    }
    lines.forEachIndexed { index, line ->
        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (line.isBound) {
                // A LINE DRAWN FROM A VISIT IS BOUND TO IT (#408): its money is
                // the visit's, so it offers the visit and a Remove, never fields.
                Text(line.description, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                Text(
                    "${invoiceEditLineSummary(line)}, from a visit",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                Text(
                    "This line comes from a visit, so its price is the visit's. Change it on the visit and this " +
                        "invoice follows.",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Open this visit", onClick = { onOpenVisit(line.sessionId) }, enabled = enabled)
                    GhostButton(
                        label = "Remove",
                        onClick = { setLines(lines.filterIndexed { i, _ -> i != index }) },
                        enabled = enabled,
                    )
                }
            } else {
                AuntieField(
                    value = line.description,
                    onValueChange = { setLines(lines.replacedAt(index, line.copy(description = it))) },
                    label = "Line ${index + 1} description",
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuntieField(
                        value = line.qtyText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(qtyText = it))) },
                        label = "Qty",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    AuntieField(
                        value = line.unitText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(unitText = it))) },
                        label = "Unit ($)",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    AuntieField(
                        value = line.discountText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(discountText = it))) },
                        label = "Off ($)",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                }
                val qty = parseQty(line.qtyText)
                val unit = parseDollarsToCents(line.unitText)
                Text(
                    if (qty != null && unit != null) {
                        val discount = if (line.discountText.isBlank()) 0L else parseDollarsToCents(line.discountText) ?: 0L
                        formatCents(lineAmountCents(InvoiceLineItem(qty = qty, unitCents = unit, discountCents = discount)))
                    } else {
                        "amount needs a qty and a unit price"
                    },
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Up", onClick = { setLines(lines.movedBy(index, -1)) }, enabled = enabled && index > 0)
                    GhostButton(
                        label = "Down",
                        onClick = { setLines(lines.movedBy(index, 1)) },
                        enabled = enabled && index < lines.lastIndex,
                    )
                    GhostButton(
                        label = "Remove",
                        onClick = { setLines(lines.filterIndexed { i, _ -> i != index }) },
                        enabled = enabled,
                    )
                }
            }
        }
    }
    GhostButton(label = "Add line", onClick = { setLines(lines + InvoiceEditLine()) }, enabled = enabled)
    AuntieField(
        value = draft.invoiceDiscountText,
        onValueChange = { onChange(draft.copy(invoiceDiscountText = it)) },
        label = "Invoice discount ($), optional",
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
    )
    val preview = invoiceEditPreviewOf(lines, draft.invoiceDiscountText)
    Text(
        "Total ${formatCents(preview.totalCents)}",
        style = AuntieTheme.typography.bodyMedium,
        color = c.textPrimary,
    )
    invoiceEditPendingCopy(preview.unreadable)?.let {
        Text(it, style = AuntieTheme.typography.labelSmall, color = c.textDim)
    }
}
