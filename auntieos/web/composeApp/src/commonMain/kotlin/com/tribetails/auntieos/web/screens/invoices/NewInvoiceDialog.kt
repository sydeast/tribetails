package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton

/**
 * Slice 2: New-invoice composer. Mirrors RecordPaymentDialog: a kinfolk picker
 * (live kinfolkStream), the invoice fields, client-side validation, and an
 * onConfirm(Invoice) the caller routes to FirestoreClient.createInvoice. The
 * caller surfaces any WriteResult.Err loudly (never swallowed).
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

@Composable
fun NewInvoiceDialog(
    visible: Boolean,
    client: FirestoreClient,
    onDismiss: () -> Unit,
    onConfirm: (Invoice) -> Unit,
    // PART B: when true the dialog mints a QUOTE (createQuote) and shows the
    // "send to kinfolk" toggle; the second onConfirm arg carries that choice.
    quoteMode: Boolean = false,
    onConfirmQuote: (Invoice, Boolean) -> Unit = { _, _ -> },
    // N1: preselect this household (quote composed from a kinfolk notification).
    initialKinfolkId: String = "",
) {
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolk: List<Kinfolk> = (kinfolkState as? FirestoreResult.Data)?.value ?: emptyList()
    val picks = remember(kinfolk) {
        listOf(PICK_KINFOLK) + kinfolk.map {
            KinfolkPick(it._id, "${it.firstName} ${it.lastName}".trim().ifBlank { it.email.ifBlank { it._id } })
        }
    }
    NewInvoiceDialogContent(visible, picks, onDismiss, onConfirm, quoteMode, onConfirmQuote, initialKinfolkId)
}

/**
 * Stateless body so the compose-rule test can drive it without a FirestoreClient.
 */
@Composable
internal fun NewInvoiceDialogContent(
    visible: Boolean,
    picks: List<KinfolkPick>,
    onDismiss: () -> Unit,
    onConfirm: (Invoice) -> Unit,
    quoteMode: Boolean = false,
    onConfirmQuote: (Invoice, Boolean) -> Unit = { _, _ -> },
    initialKinfolkId: String = "",
) {
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
            val draft = Invoice(
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
                // A quote's status is forced server-side; stamp "quote" locally so
                // the optimistic value is honest before the stream refreshes.
                status = if (quoteMode) "quote" else status.trim(),
            )
            if (quoteMode) onConfirmQuote(draft, sendToKinfolk) else onConfirm(draft)
        }
    }

    AuntieDialog(
        visible = visible,
        title = if (quoteMode) "New quote" else "New invoice",
        onDismiss = onDismiss,
        maxWidth = 460.dp,
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

        AuntieSelectField(
            label = "Household",
            options = picks,
            selected = pick,
            onSelect = { pick = it },
            optionLabel = { it.name },
            required = true,
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value = invoiceNumber,
            onValueChange = { invoiceNumber = it },
            label = "Invoice number",
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value = clientName,
            onValueChange = { clientName = it },
            label = "Client, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value = address,
            onValueChange = { address = it },
            label = "Address, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            BottomBorderField(
                value = date,
                onValueChange = { date = it },
                label = "Date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                isError = date.isNotBlank() && !isValidNewInvoiceIsoDate(date),
                modifier = Modifier.weight(1f),
            )
            BottomBorderField(
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
            BottomBorderField(
                value = totalText,
                onValueChange = { totalText = it },
                label = "Total ($)",
                modifier = Modifier.weight(1f),
                keyboardType = KeyboardType.Decimal,
            )
            BottomBorderField(
                value = amountDueText,
                onValueChange = { amountDueText = it },
                label = "Amount due ($)",
                modifier = Modifier.weight(1f),
                keyboardType = KeyboardType.Decimal,
            )
        }
        BottomBorderField(
            value = terms,
            onValueChange = { terms = it },
            label = "Terms, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            value = discount,
            onValueChange = { discount = it },
            label = "Discount, optional",
            modifier = Modifier.fillMaxWidth(),
        )
        if (quoteMode) {
            // A quote always mints in QUOTE status server-side, so there is no
            // status picker. Instead offer the "send to kinfolk" issuance toggle.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "Send to kinfolk now",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                AuntieToggle(checked = sendToKinfolk, onCheckedChange = { sendToKinfolk = it })
            }
        } else {
            AuntieSelectField(
                label = "Status",
                options = listOf("draft", "sent"),
                selected = status,
                onSelect = { status = it },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
