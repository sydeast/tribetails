package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton

/**
 * The invoice editor (#1174) on the desktop console: number, date, due date,
 * terms, household, client, address, the legacy discount note (#1198), line
 * items and the whole-invoice discount, saved through `updateInvoice`. Under a
 * `metadataOnly` scope the money is SHOWN read-only under the "Money is locked"
 * banner web shows; every non-money field stays editable.
 */
@Composable
internal fun InvoiceEditDialog(
    draft: InvoiceEditDraft?,
    error: String?,
    saving: Boolean,
    onChange: (InvoiceEditDraft) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    val enabled = !saving
    AuntieDialog(
        visible = draft != null,
        title = "Edit invoice",
        onDismiss = onDismiss,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = enabled)
            PrimaryButton(
                label = if (saving) "Saving..." else "Save changes",
                onClick = onSave,
                loading = saving,
                enabled = enabled,
            )
        },
    ) {
        if (draft == null) return@AuntieDialog
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (error != null) {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't save") {
                    Text(error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            if (!draft.moneyEditable) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Money is locked") {
                    Text(
                        "A payment has already been recorded against this invoice, so its line items and " +
                            "discounts cannot change. The number, dates, terms, household, client, address and " +
                            "discount note can still be corrected.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
            BottomBorderField(
                value = draft.invoiceNumber,
                onValueChange = { onChange(draft.copy(invoiceNumber = it)) },
                label = "Invoice number",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    value = draft.date,
                    onValueChange = { onChange(draft.copy(date = it)) },
                    label = "Date",
                    placeholder = "YYYY-MM-DD",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    value = draft.dueDate,
                    onValueChange = { onChange(draft.copy(dueDate = it)) },
                    label = "Due date",
                    placeholder = "YYYY-MM-DD",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
            }
            BottomBorderField(
                value = draft.terms,
                onValueChange = { onChange(draft.copy(terms = it)) },
                label = "Terms",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value = draft.kinfolkName,
                onValueChange = { onChange(draft.copy(kinfolkName = it)) },
                label = "Household",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value = draft.client,
                onValueChange = { onChange(draft.copy(client = it)) },
                label = "Client",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value = draft.address,
                onValueChange = { onChange(draft.copy(address = it)) },
                label = "Address",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            // The LEGACY free-text discount, printed as typed and never part
            // of the total. Named a note so it cannot be mistaken for the
            // money discount under the line items.
            BottomBorderField(
                value = draft.discount,
                onValueChange = { onChange(draft.copy(discount = it)) },
                label = "Discount note",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Line items", style = AuntieTheme.typography.labelSmall, color = c.textDim)
            if (draft.moneyEditable) EditableLines(draft, enabled, onChange) else LockedLines(draft)
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
        Column {
            Text(line.description.ifBlank { "no description" }, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            Text(invoiceEditLineSummary(line), style = AuntieTheme.typography.labelSmall, color = c.textDim)
        }
    }
    if (draft.invoiceDiscountText.isNotBlank()) {
        Text(
            "Invoice discount: ${parseDollarsToCents(draft.invoiceDiscountText)?.let(::formatEditCents) ?: draft.invoiceDiscountText}",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    }
}

@Composable
private fun EditableLines(draft: InvoiceEditDraft, enabled: Boolean, onChange: (InvoiceEditDraft) -> Unit) {
    val c = AuntieTheme.colors
    val lines = draft.lines
    fun setLines(next: List<InvoiceEditLine>) = onChange(draft.copy(lines = next))

    if (lines.isEmpty()) {
        Text(
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
                // Bound to a visit (#408): its money is the visit's. Remove is
                // allowed; taking work off an invoice is a different decision
                // from rewriting what that work cost.
                Text(line.description, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                Text("${invoiceEditLineSummary(line)}, from a visit", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                Text(
                    "This line comes from a visit, so its price is the visit's. Change it on the visit and this " +
                        "invoice follows.",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                GhostButton(
                    label = "Remove",
                    onClick = { setLines(lines.filterIndexed { i, _ -> i != index }) },
                    enabled = enabled,
                )
            } else {
                BottomBorderField(
                    value = line.description,
                    onValueChange = { setLines(lines.replacedAt(index, line.copy(description = it))) },
                    label = "Line ${index + 1} description",
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BottomBorderField(
                        value = line.qtyText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(qtyText = it))) },
                        label = "Qty",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                    BottomBorderField(
                        value = line.unitText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(unitText = it))) },
                        label = "Unit ($)",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                    BottomBorderField(
                        value = line.discountText,
                        onValueChange = { setLines(lines.replacedAt(index, line.copy(discountText = it))) },
                        label = "Off ($)",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                }
                val qty = parseQty(line.qtyText)
                val unit = parseDollarsToCents(line.unitText)
                Text(
                    if (qty != null && unit != null) {
                        val discount = if (line.discountText.isBlank()) 0L else parseDollarsToCents(line.discountText) ?: 0L
                        formatEditCents(lineAmountCents(InvoiceEditLineItem(line.description, qty, unit, discount)))
                    } else {
                        "amount needs a qty and a unit price"
                    },
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
    BottomBorderField(
        value = draft.invoiceDiscountText,
        onValueChange = { onChange(draft.copy(invoiceDiscountText = it)) },
        label = "Invoice discount ($), optional",
        enabled = enabled,
        keyboardType = KeyboardType.Decimal,
        modifier = Modifier.fillMaxWidth(),
    )
    val preview = invoiceEditPreviewOf(lines, draft.invoiceDiscountText)
    Text("Total ${formatEditCents(preview.totalCents)}", style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    invoiceEditPendingCopy(preview.unreadable)?.let {
        Text(it, style = AuntieTheme.typography.labelSmall, color = c.textDim)
    }
}
