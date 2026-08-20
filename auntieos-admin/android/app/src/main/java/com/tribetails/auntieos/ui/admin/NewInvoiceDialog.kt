package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
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
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ReceiptText
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.domain.centsToDollars
import com.tribetails.auntieos.domain.formatCents
import com.tribetails.auntieos.domain.invoiceTermsDefs
import com.tribetails.auntieos.domain.resolveDueDate
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The Android new-invoice composer.
 *
 * CREATING AN INVOICE IS AN ACT OF SELECTION OVER WORK THAT ALREADY EXISTS, NOT
 * AN ACT OF DESCRIPTION. That is the finding behind issue #408, and this dialog
 * is arranged around it: pick a household, see its un-invoiced work, tick what
 * this invoice covers, create it. Everything the old form asked for was either
 * inherited from the household, derived from the terms, computed from the lines,
 * or assigned by the server, and every one of them was being put to the operator
 * as a question. `InvoiceComposer.kt` holds the decisions and the sentences; this
 * file is the arrangement of them on a screen.
 *
 * THE BLANK PATH IS STILL HERE, as the exception it is. A household with no
 * logged work is a real case, and it is the only path where a total is typed.
 *
 * ONE ENTRY POINT. A quote is an invoice in QUOTE status, which is what the
 * status filters have always said, so there is one composer and the kind is
 * chosen inside it rather than by picking one of two buttons before the operator
 * has seen what the work looks like.
 *
 * FAIL LOUD. A rejected callable renders inline and leaves the dialog open with
 * the form intact, never a silent close. Every control is disabled while the
 * create is in flight, and the create button carries its own busy state.
 */

/** A household option for the picker. Empty [id] = "pick a household" sentinel. */
internal data class KinfolkPick(val id: String, val name: String)
internal val PICK_KINFOLK = KinfolkPick("", "Pick a household...")

/**
 * Everything the composer decided, handed to the caller in one piece.
 *
 * A REQUEST, NOT A DOCUMENT. [lineItems] null means this invoice is not
 * itemized, which is the blank path, and that is NOT the same as an empty list:
 * the server reads the key's presence as "this invoice is itemized", and an
 * empty list would arm `updateInvoice`'s recompute on an invoice whose total was
 * typed by hand, so a later due-date correction would rewrite it to $0.
 */
data class NewInvoiceRequest(
    val kind: InvoiceCreateKind,
    val invoice: Invoice,
    val sendToKinfolk: Boolean = false,
    /** The structured terms rule, on the wire. The server owns the due date when this is set. */
    val termsCode: String? = null,
    val lineItems: List<InvoiceLineItem>? = null,
    val invoiceDiscountCents: Long? = null,
)

@Composable
fun NewInvoiceDialog(
    visible: Boolean,
    kinfolk: List<Kinfolk>,
    todayIso: String,
    onDismiss: () -> Unit,
    onConfirm: (NewInvoiceRequest) -> Unit,
    onOpenVisit: (String) -> Unit,
    loadUninvoiced: suspend (String, String?, String?) -> Result<ListUninvoicedSessionsResult>,
    setDoNotInvoice: suspend (List<String>, Boolean, String) -> Result<SetSessionDoNotInvoiceResult>,
    initialKind: InvoiceCreateKind = InvoiceCreateKind.INVOICE,
    // A notification routed here to compose for one household: preselect it.
    initialKinfolkId: String = "",
    submitting: Boolean = false,
    submitError: String? = null,
) {
    if (!visible) return

    val c = AuntieTheme.colors

    val picks = remember(kinfolk) {
        listOf(PICK_KINFOLK) + kinfolk.map {
            KinfolkPick(it.id, "${it.firstName} ${it.lastName}".trim().ifBlank { it.email.ifBlank { it.id } })
        }
    }

    var pick by remember(initialKinfolkId, picks) {
        mutableStateOf(picks.firstOrNull { it.id == initialKinfolkId } ?: PICK_KINFOLK)
    }
    var kind by remember(initialKind) { mutableStateOf(initialKind) }
    var path by remember { mutableStateOf(InvoiceCreatePath.WORK) }
    var date by remember(todayIso) { mutableStateOf(todayIso) }
    var termsCode by remember { mutableStateOf(InvoiceTermsCode.DUE_ON_RECEIPT) }
    var customDueDate by remember { mutableStateOf("") }
    var totalText by remember { mutableStateOf("") }
    var invoiceDiscountText by remember { mutableStateOf("") }
    var extraLines by remember { mutableStateOf<List<ComposerDraftLine>>(emptyList()) }
    var sendToKinfolk by remember { mutableStateOf(false) }
    var validationError by remember { mutableStateOf<String?>(null) }

    // The work half: what the picker loaded, and what is ticked.
    var sessions by remember { mutableStateOf<List<ListUninvoicedSessionsResultSession>>(emptyList()) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var prices by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    val isQuote = kind == InvoiceCreateKind.QUOTE
    val onWork = path == InvoiceCreatePath.WORK
    val householdLabel = if (pick.id.isNotBlank()) pick.name else "this household"

    /**
     * The due date these terms mean, worked out through the SAME resolver the
     * server re-runs before it writes. Shown, never typed, unless the operator
     * picked the terms that hand the date back to them.
     */
    val due = resolveDueDate(
        code = termsCode,
        invoiceDate = date,
        serviceDates = if (onWork) sessions.filter { it.sessionId in selected }.map { it.startTime } else emptyList(),
        now = todayIso,
    )
    val dueDateForSubmit = if (termsCode == InvoiceTermsCode.CUSTOM) customDueDate.trim() else due.dueDate.orEmpty()

    /** The lines this invoice would carry, and the live total under them. */
    val money = if (onWork) composerMoney(sessions, selected, prices, extraLines, invoiceDiscountText) else null

    val blocked = composerBlockedReason(
        kinfolkId = pick.id,
        path = path,
        termsCode = termsCode,
        due = due,
        date = date,
        customDueDate = customDueDate,
        selectedCount = if (onWork) selected.size else 0,
        draftCount = extraLines.size,
        money = money,
        totalText = totalText,
    )
    val termsNote = composerTermsNote(termsCode, due, date)

    val submit: () -> Unit = submit@{
        if (submitting) return@submit
        val reason = blocked
        if (reason != null) {
            validationError = reason
            return@submit
        }
        validationError = null

        val base = Invoice(
            kinfolkId = pick.id,
            kinfolkName = pick.name,
            // INHERITED from the household, not asked. `address` is deliberately
            // left blank: nothing on the kinfolk model carries a postal address,
            // so asking here would be asking the operator to retype what nothing
            // knows. It stays settable through `updateInvoice`.
            client = pick.name,
            date = date.trim(),
            dueDate = dueDateForSubmit,
            // A NEW INVOICE IS A DRAFT. Sending is `reviewAndSendDraftInvoice`,
            // a separate and later action. A quote's status is forced QUOTE
            // server-side, so the composer states nothing about it.
            status = if (isQuote) "" else "draft",
        )

        if (onWork) {
            val lines = money?.lines
            if (money == null || lines == null || lines.isEmpty()) {
                validationError = money?.error ?: "This invoice has no work on it yet."
                return@submit
            }
            base.total = centsToDollars(money.totalCents)
            // Both dollar scalars are the PROJECTION of the same cents figure the
            // server recomputes. Neither is read off a form field, because there
            // is no field for them: the amount due on an invoice nobody has paid
            // is its total.
            base.amountDue = centsToDollars(money.totalCents)
            base.sessionIds = lines.mapNotNull { it.sessionId.takeIf(String::isNotBlank) }
            onConfirm(
                NewInvoiceRequest(
                    kind = kind,
                    invoice = base,
                    sendToKinfolk = isQuote && sendToKinfolk,
                    termsCode = termsCode.wire,
                    lineItems = lines,
                    invoiceDiscountCents = money.invoiceDiscountCents,
                ),
            )
        } else {
            val typed = totalText.trim().toDoubleOrNull()
            if (typed == null) {
                validationError = "Total must be zero or greater"
                return@submit
            }
            base.total = typed
            base.amountDue = typed
            onConfirm(
                NewInvoiceRequest(
                    kind = kind,
                    invoice = base,
                    sendToKinfolk = isQuote && sendToKinfolk,
                    termsCode = termsCode.wire,
                    // NO lineItems AT ALL on the blank path, not an empty list.
                    lineItems = null,
                    invoiceDiscountCents = null,
                ),
            )
        }
    }

    AuntieDialog(
        visible = true,
        title = if (isQuote) "New quote" else "New invoice",
        onDismiss = { if (!submitting) onDismiss() },
        maxWidth = 560.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.ReceiptText, tone = AuntieStatusTone.Teal, size = 38.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = !submitting)
            PrimaryButton(
                label = composerCreateLabel(kind, if (onWork) selected.size else 0),
                onClick = submit,
                enabled = !submitting && blocked == null,
                loading = submitting,
            )
        },
    ) {
        validationError?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't create this yet") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        submitError?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't create this yet") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        AuntieDropdownField(
            value = pick,
            options = picks,
            onSelect = {
                pick = it
                // A new household means new work, and none of the old selection
                // belongs to it. Cleared here rather than inside the picker, so
                // "what is on this invoice" stays answerable in one place.
                selected = emptySet()
                sessions = emptyList()
                prices = emptyMap()
                path = InvoiceCreatePath.WORK
            },
            displayText = { it.name },
            label = "Household",
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth(),
        )

        // A quote is this same document in QUOTE status, not a separate entry
        // point (#408), so the kind is a field here rather than a second button
        // on the Invoices screen.
        AuntieDropdownField(
            value = kind,
            options = InvoiceCreateKind.entries.toList(),
            onSelect = { kind = it },
            displayText = { it.optionLabel },
            label = "What is this",
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth(),
        )

        when {
            pick.id.isBlank() -> Text(
                "Pick a household and its un-invoiced work appears here, ready to tick.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            onWork -> UninvoicedVisitsPicker(
                kinfolkId = pick.id,
                householdLabel = householdLabel,
                todayIso = todayIso,
                selected = selected,
                onSelectedChange = { selected = it },
                prices = prices,
                onPriceChange = { id, text -> prices = prices + (id to text) },
                onSessionsLoaded = { sessions = it },
                onWriteBlankInvoice = { path = InvoiceCreatePath.BLANK },
                onOpenVisit = onOpenVisit,
                load = loadUninvoiced,
                setDoNotInvoice = setDoNotInvoice,
                disabled = submitting,
            )

            else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "A blank invoice, with a total you type. Nothing on it is linked to logged work, so " +
                        "nothing here can tell whether this household has already been billed for it.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                AuntieField(
                    value = totalText,
                    onValueChange = { totalText = it },
                    label = "Total ($)",
                    enabled = !submitting,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                GhostButton(
                    label = "Bill this household's logged work instead",
                    onClick = { path = InvoiceCreatePath.WORK },
                    enabled = !submitting,
                )
            }
        }

        if (onWork && pick.id.isNotBlank()) {
            ExtraChargesEditor(
                drafts = extraLines,
                onChange = { extraLines = it },
                invoiceDiscountText = invoiceDiscountText,
                onInvoiceDiscountChange = { invoiceDiscountText = it },
                enabled = !submitting,
            )
            // NO FIGURE IS PROMISED UNTIL THERE IS ONE. With nothing on the
            // invoice the arithmetic is a perfectly valid $0.00, and printing it
            // would say this invoice "will be created for $0.00" when in fact it
            // cannot be created at all. An empty set and a zero total are
            // different facts and must not read alike.
            Text(
                if (money?.lines?.isNotEmpty() == true) {
                    "This invoice will be created for ${formatCents(money.totalCents)}, worked out from the " +
                        "work it covers. There is nowhere to type a total, so it can never say a different " +
                        "number from the work it lists."
                } else {
                    "Totals are worked out from the work this invoice covers. Tick a visit above, or add a " +
                        "line of your own."
                },
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AuntieField(
                value = date,
                onValueChange = { date = it },
                label = "Date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                enabled = !submitting,
                isError = date.isNotBlank() && !isValidNewInvoiceIsoDate(date),
                modifier = Modifier.weight(1f),
            )
            AuntieField(
                value = if (termsCode == InvoiceTermsCode.CUSTOM) customDueDate else due.dueDate.orEmpty(),
                onValueChange = { customDueDate = it },
                label = "Due date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                // DISABLED WITH THE REASON STATED BELOW, never hidden. The terms
                // decide this date, and the way to change it is to change them.
                enabled = !submitting && termsCode == InvoiceTermsCode.CUSTOM,
                isError = termsCode == InvoiceTermsCode.CUSTOM &&
                    customDueDate.isNotBlank() &&
                    !isValidNewInvoiceIsoDate(customDueDate),
                modifier = Modifier.weight(1f),
            )
        }

        AuntieDropdownField(
            value = termsCode,
            options = invoiceTermsDefs(),
            onSelect = { termsCode = it },
            displayText = { it.label },
            label = "Terms",
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth(),
        )

        Text(termsNote, style = AuntieTheme.typography.bodySmall, color = c.textDim)

        if (isQuote) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Send to kinfolk", style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    Text(
                        "Notify the household that a quote is ready.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                AuntieToggle(
                    checked = sendToKinfolk,
                    onCheckedChange = { sendToKinfolk = it },
                    enabled = !submitting,
                )
            }
        }

        // The disabled button's reason, stated where the button is rather than
        // left for the operator to work out by clicking it. Not repeated when the
        // terms line above is already saying the same sentence: a reason printed
        // twice reads as two problems.
        if (blocked != null && blocked != termsNote && !submitting) {
            Text(blocked, style = AuntieTheme.typography.bodySmall, color = c.error)
        }

        if (!isQuote) {
            Text(
                "This lands as a draft. Nothing reaches $householdLabel until you send it from the invoice " +
                    "itself.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/**
 * The typed extra charges, and the whole-invoice discount.
 *
 * AN EXTRA CHARGE IS AN ORDINARY LINE. A mileage charge and a dog walk are both
 * things this invoice bills for, so a typed row is the same shape as a row drawn
 * from a visit; only its origin differs. Bound rows are not editable here at all,
 * which is why they live in the picker above rather than in this list.
 */
@Composable
private fun ExtraChargesEditor(
    drafts: List<ComposerDraftLine>,
    onChange: (List<ComposerDraftLine>) -> Unit,
    invoiceDiscountText: String,
    onInvoiceDiscountChange: (String) -> Unit,
    enabled: Boolean,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Extra charges", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        if (drafts.isEmpty()) {
            Text(
                "No extra charges. Anything the visits above do not cover goes here.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
        drafts.forEachIndexed { index, draft ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                AuntieField(
                    value = draft.description,
                    onValueChange = { onChange(drafts.replacedAt(index, draft.copy(description = it))) },
                    label = "What is this charge",
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    AuntieField(
                        value = draft.qtyText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(qtyText = it))) },
                        label = "Qty",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    AuntieField(
                        value = draft.unitText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(unitText = it))) },
                        label = "Each ($)",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                    AuntieField(
                        value = draft.discountText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(discountText = it))) },
                        label = "Less ($)",
                        enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.weight(1f),
                    )
                }
                GhostButton(
                    label = "Remove this charge",
                    onClick = { onChange(drafts.filterIndexed { i, _ -> i != index }) },
                    enabled = enabled,
                )
            }
        }
        GhostButton(
            label = "Add an extra charge",
            onClick = { onChange(drafts + ComposerDraftLine()) },
            enabled = enabled,
        )
        AuntieField(
            value = invoiceDiscountText,
            onValueChange = onInvoiceDiscountChange,
            label = "Discount off the whole invoice ($)",
            enabled = enabled,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** The list with one entry swapped. Kept local so the editor never mutates its input. */
private fun List<ComposerDraftLine>.replacedAt(index: Int, value: ComposerDraftLine): List<ComposerDraftLine> =
    mapIndexed { i, existing -> if (i == index) value else existing }
