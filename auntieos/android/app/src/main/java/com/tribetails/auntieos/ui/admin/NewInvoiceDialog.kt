package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ReceiptText
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Slice 2: Android New-invoice composer. Mirrors the web composer: a kinfolk
 * picker fed by [AdminDataViewModel.kinfolkDirectory], the invoice fields, the
 * shared pure validation in [validateNewInvoice], and onConfirm(Invoice) the
 * caller routes to viewModel.createInvoice. The caller surfaces the VM error
 * StateFlow loudly (never swallowed).
 */

/** A household option for the picker. Empty [id] = "pick a household" sentinel. */
internal data class KinfolkPick(val id: String, val name: String)
internal val PICK_KINFOLK = KinfolkPick("", "Pick a household...")

/** Pure, unit-tested validation. Returns an error string, or null when valid. */
internal fun validateNewInvoice(
    kinfolkId: String,
    invoiceNumber: String,
    totalText: String,
    amountDueText: String,
    date: String,
    dueDate: String,
): String? {
    val total = totalText.toDoubleOrNull()
    val amountDue = amountDueText.toDoubleOrNull()
    return when {
        kinfolkId.isBlank() -> "Pick a household for this invoice"
        invoiceNumber.isBlank() -> "Invoice number is required"
        total == null || total < 0.0 -> "Total must be zero or greater"
        amountDue == null || amountDue < 0.0 -> "Amount due must be zero or greater"
        date.isNotBlank() && !isValidNewInvoiceIsoDate(date) -> "Date must be a real YYYY-MM-DD date"
        dueDate.isNotBlank() && !isValidNewInvoiceIsoDate(dueDate) -> "Due date must be a real YYYY-MM-DD date"
        else -> null
    }
}

/** A YYYY-MM-DD that parses to a real calendar date. */
internal fun isValidNewInvoiceIsoDate(value: String): Boolean {
    val s = value.trim()
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(s)) return false
    val month = s.substring(5, 7).toIntOrNull() ?: return false
    val day = s.substring(8, 10).toIntOrNull() ?: return false
    if (month !in 1..12) return false
    val daysInMonth = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        else -> 29
    }
    return day in 1..daysInMonth
}

/**
 * Composer for both an invoice and a quote (PART B). A quote is NOT a separate
 * model: it is an invoice in QUOTE status, so the quote path reuses this exact
 * composer + the shared [validateNewInvoice]. When [quoteMode] is true the status
 * dropdown is replaced by a "Send to kinfolk" toggle (drives createQuote's
 * sendToKinfolk arg) and the title/CTA read "quote". onConfirm hands back the built
 * Invoice plus the sendToKinfolk choice; the caller routes to createInvoice (invoice
 * mode) or createQuote (quote mode).
 */
@Composable
fun NewInvoiceDialog(
    visible: Boolean,
    kinfolk: List<Kinfolk>,
    onDismiss: () -> Unit,
    onConfirm: (Invoice, sendToKinfolk: Boolean) -> Unit,
    quoteMode: Boolean = false,
    // N1: preselect this household (quote composed from a kinfolk notification).
    initialKinfolkId: String = "",
) {
    if (!visible) return

    val picks = remember(kinfolk) {
        listOf(PICK_KINFOLK) + kinfolk.map {
            KinfolkPick(it.id, "${it.firstName} ${it.lastName}".trim().ifBlank { it.email.ifBlank { it.id } })
        }
    }

    var pick by remember(initialKinfolkId, picks) {
        mutableStateOf(picks.firstOrNull { it.id == initialKinfolkId } ?: PICK_KINFOLK)
    }
    var invoiceNumber by remember { mutableStateOf("") }
    var clientName by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var terms by remember { mutableStateOf("") }
    var dueDate by remember { mutableStateOf("") }
    var discount by remember { mutableStateOf("") }
    var totalText by remember { mutableStateOf("") }
    var amountDueText by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("draft") }
    var sendToKinfolk by remember { mutableStateOf(false) }
    var validationError by remember { mutableStateOf<String?>(null) }

    val c = AuntieTheme.colors

    val submit: () -> Unit = {
        val err = validateNewInvoice(pick.id, invoiceNumber, totalText, amountDueText, date, dueDate)
        if (err != null) {
            validationError = err
        } else {
            validationError = null
            onConfirm(
                Invoice(
                    kinfolkId = pick.id,
                    kinfolkName = pick.name,
                    invoiceNumber = invoiceNumber.trim(),
                    client = clientName.trim(),
                    address = address.trim(),
                    date = date.trim(),
                    terms = terms.trim(),
                    dueDate = dueDate.trim(),
                    discount = discount.trim(),
                    total = totalText.toDoubleOrNull() ?: 0.0,
                    amountDue = amountDueText.toDoubleOrNull() ?: 0.0,
                    // In quote mode the server forces QUOTE status regardless of this
                    // value; we still stamp it so the optimistic Invoice reads right.
                    status = if (quoteMode) "QUOTE" else status.trim(),
                ),
                if (quoteMode) sendToKinfolk else false,
            )
        }
    }

    AuntieDialog(
        visible = visible,
        title = if (quoteMode) "New quote" else "New invoice",
        onDismiss = onDismiss,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.ReceiptText, tone = AuntieStatusTone.Teal, size = 38.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(label = if (quoteMode) "Create quote" else "Save", onClick = submit)
        },
    ) {
        validationError?.let { err ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(11.dp))
                    .background(c.error.copy(alpha = 0.12f))
                    .border(AuntieTheme.dims.borderHairline, c.error.copy(alpha = 0.45f), RoundedCornerShape(11.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Text(err, style = AuntieTheme.typography.bodySmall, color = c.error)
            }
        }

        AuntieDropdownField(
            value = pick,
            options = picks,
            onSelect = { pick = it },
            displayText = { it.name },
            label = "Household",
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = invoiceNumber,
            onValueChange = { invoiceNumber = it },
            label = "Invoice number",
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = clientName,
            onValueChange = { clientName = it },
            label = "Client, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = address,
            onValueChange = { address = it },
            label = "Address, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AuntieField(
                value = date,
                onValueChange = { date = it },
                label = "Date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                isError = date.isNotBlank() && !isValidNewInvoiceIsoDate(date),
                modifier = Modifier.weight(1f),
            )
            AuntieField(
                value = dueDate,
                onValueChange = { dueDate = it },
                label = "Due date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                isError = dueDate.isNotBlank() && !isValidNewInvoiceIsoDate(dueDate),
                modifier = Modifier.weight(1f),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AuntieField(
                value = totalText,
                onValueChange = { totalText = it },
                label = "Total ($)",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
            AuntieField(
                value = amountDueText,
                onValueChange = { amountDueText = it },
                label = "Amount due ($)",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
        }
        AuntieField(
            value = terms,
            onValueChange = { terms = it },
            label = "Terms, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = discount,
            onValueChange = { discount = it },
            label = "Discount, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        if (quoteMode) {
            // Quote mode: a quote always mints in QUOTE status (server-forced), so
            // there is no status dropdown. Instead, offer to dispatch the issued-quote
            // notification to the kinfolk (createQuote's sendToKinfolk arg).
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Send to kinfolk",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                    Text(
                        "Notify the household that a quote is ready.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                AuntieToggle(
                    checked = sendToKinfolk,
                    onCheckedChange = { sendToKinfolk = it },
                )
            }
        } else {
            AuntieDropdownField(
                value = status,
                options = listOf("draft", "sent"),
                onSelect = { status = it },
                displayText = { it },
                label = "Status",
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
