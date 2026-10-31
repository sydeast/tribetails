package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import com.tribetails.auntieos.web.data.DoNotInvoiceResult
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.rememberLiveRead
import kotlinx.datetime.TimeZone
import kotlinx.datetime.todayIn
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #1178: the desktop new-invoice composer, on the same flow as admin web
 * (`InvoiceCreate.tsx`) and admin Android (`ui/admin/NewInvoiceDialog.kt`).
 *
 * Pick a household; its un-invoiced completed visits load ticked; add extra
 * charges; pick terms and the due date is worked out and locked; create. The
 * server assigns the invoice number, and a new invoice is a draft. A household
 * with no logged work can still get a blank invoice with a typed total, the
 * exception it is on the other two clients. `InvoiceComposer.kt` holds the
 * decisions; this file arranges them.
 *
 * The dialog stays open while the create is in flight and after a refusal, so
 * the ticks and lines survive a retry. The caller closes it on success.
 */

/** A household option for the picker. Empty [id] = "pick a household" sentinel. */
internal data class KinfolkPick(val id: String, val name: String)
internal val PICK_KINFOLK = KinfolkPick("", "Pick a household...")

/** Today as YYYY-MM-DD in the operator's own zone. */
@OptIn(ExperimentalTime::class)
internal fun localTodayIso(): String = Clock.System.todayIn(TimeZone.currentSystemDefault()).toString()

@Composable
fun NewInvoiceDialog(
    visible: Boolean,
    client: FirestoreClient,
    onDismiss: () -> Unit,
    onConfirm: (NewInvoiceRequest) -> Unit,
    // A quote is this same document in QUOTE status; the toggle for notifying
    // the household rides on the request.
    quoteMode: Boolean = false,
    // N1: preselect this household (quote composed from a kinfolk notification).
    initialKinfolkId: String = "",
    submitting: Boolean = false,
    submitError: String? = null,
) {
    // #898: a failed read used to leave the picker showing only "Pick a
    // household..." with no indication anything went wrong.
    val kinfolkRead = rememberLiveRead { client.kinfolkStream() }
    val kinfolk: List<Kinfolk> = kinfolkRead.data ?: emptyList()
    val picks = remember(kinfolk) {
        listOf(PICK_KINFOLK) + kinfolk.map {
            KinfolkPick(it._id, "${it.firstName} ${it.lastName}".trim().ifBlank { it.email.ifBlank { it._id } })
        }
    }
    val todayIso = remember { localTodayIso() }
    NewInvoiceDialogContent(
        visible = visible,
        picks = picks,
        todayIso = todayIso,
        onDismiss = onDismiss,
        onConfirm = onConfirm,
        loadUninvoiced = { id, from, to -> client.listUninvoicedSessions(id, from, to) },
        setDoNotInvoice = { ids, flag, reason -> client.setSessionDoNotInvoice(ids, flag, reason) },
        quoteMode = quoteMode,
        initialKinfolkId = initialKinfolkId,
        pickError = kinfolkRead.error,
        onRetryPick = kinfolkRead::retry,
        retryingPick = kinfolkRead.retrying,
        submitting = submitting,
        submitError = submitError,
    )
}

/** Stateless of any client, so a compose test can drive it with fake callables. */
@Composable
internal fun NewInvoiceDialogContent(
    visible: Boolean,
    picks: List<KinfolkPick>,
    todayIso: String,
    onDismiss: () -> Unit,
    onConfirm: (NewInvoiceRequest) -> Unit,
    loadUninvoiced: suspend (String, String?, String?) -> WriteResult<UninvoicedSessionsResult>,
    setDoNotInvoice: suspend (List<String>, Boolean, String) -> WriteResult<DoNotInvoiceResult>,
    quoteMode: Boolean = false,
    initialKinfolkId: String = "",
    // #898: the household picker's load state.
    pickError: String? = null,
    onRetryPick: (() -> Unit)? = null,
    retryingPick: Boolean = false,
    submitting: Boolean = false,
    submitError: String? = null,
) {
    if (!visible) return
    val c = AuntieTheme.colors

    var pick by remember(initialKinfolkId, picks) {
        mutableStateOf(picks.firstOrNull { it.id == initialKinfolkId } ?: PICK_KINFOLK)
    }
    var path by remember { mutableStateOf(InvoiceCreatePath.WORK) }
    var date by remember(todayIso) { mutableStateOf(todayIso) }
    var termsCode by remember { mutableStateOf(InvoiceTermsCode.DUE_ON_RECEIPT) }
    var customDueDate by remember { mutableStateOf("") }
    var totalText by remember { mutableStateOf("") }
    var invoiceDiscountText by remember { mutableStateOf("") }
    var extraLines by remember { mutableStateOf<List<ComposerDraftLine>>(emptyList()) }
    var sendToKinfolk by remember { mutableStateOf(false) }
    var validationError by remember { mutableStateOf<String?>(null) }
    var sessions by remember { mutableStateOf<List<UninvoicedSession>>(emptyList()) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var prices by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    val onWork = path == InvoiceCreatePath.WORK
    val householdLabel = if (pick.id.isNotBlank()) pick.name else "this household"

    // Worked out through the same resolver the server re-runs before it writes.
    val due = resolveDueDate(
        code = termsCode,
        invoiceDate = date,
        serviceDates = if (onWork) sessions.filter { it.sessionId in selected }.map { it.startTime } else emptyList(),
        now = todayIso,
    )
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
        if (blocked != null) {
            validationError = blocked
            return@submit
        }
        val built = buildNewInvoiceRequest(
            isQuote = quoteMode,
            kinfolkId = pick.id,
            kinfolkName = pick.name,
            path = path,
            date = date,
            termsCode = termsCode,
            due = due,
            customDueDate = customDueDate,
            money = money,
            totalText = totalText,
            sendToKinfolk = sendToKinfolk,
        )
        validationError = built.error
        built.request?.let(onConfirm)
    }

    AuntieDialog(
        visible = true,
        title = if (quoteMode) "New quote" else "New invoice",
        onDismiss = { if (!submitting) onDismiss() },
        maxWidth = 560.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.ReceiptText, tone = AuntieStatusTone.Teal, size = 38.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, enabled = !submitting)
            PrimaryButton(
                label = composerCreateLabel(quoteMode, if (onWork) selected.size else 0),
                onClick = submit,
                enabled = !submitting && blocked == null,
                loading = submitting,
            )
        },
    ) {
        (validationError ?: submitError)?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Can't create this yet") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        pickError?.let {
            LoadErrorBanner("Couldn't load households", it, onRetry = onRetryPick, retrying = retryingPick)
        }
        AuntieSelectField(
            label = "Household",
            options = picks,
            selected = pick,
            onSelect = {
                // New household, new work: none of the old selection belongs to it.
                pick = it
                selected = emptySet()
                sessions = emptyList()
                prices = emptyMap()
                path = InvoiceCreatePath.WORK
            },
            optionLabel = { it.name },
            required = true,
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth(),
        )

        when {
            pick.id.isBlank() -> Text(
                "Pick a household to see its un-invoiced visits.",
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
                load = loadUninvoiced,
                setDoNotInvoice = setDoNotInvoice,
                disabled = submitting,
            )

            else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "A blank invoice with a typed total. It is not linked to any logged visit.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                BottomBorderField(
                    value = totalText,
                    onValueChange = { totalText = it },
                    label = "Total ($)",
                    enabled = !submitting,
                    keyboardType = KeyboardType.Decimal,
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
            // No figure until there is one: an empty invoice is not a $0.00 invoice.
            val lines = money?.lines
            if (money != null && !lines.isNullOrEmpty()) {
                Text(
                    "Total ${formatInvoiceCents(money.totalCents)}",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BottomBorderField(
                value = date,
                onValueChange = { date = it },
                label = "Date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                enabled = !submitting,
                isError = date.isNotBlank() && !isValidNewInvoiceIsoDate(date),
                modifier = Modifier.weight(1f),
            )
            BottomBorderField(
                value = if (termsCode == InvoiceTermsCode.CUSTOM) customDueDate else due.dueDate.orEmpty(),
                onValueChange = { customDueDate = it },
                label = "Due date (YYYY-MM-DD)",
                placeholder = "YYYY-MM-DD",
                // Locked unless the terms hand the date back; the note below says why.
                enabled = !submitting && termsCode == InvoiceTermsCode.CUSTOM,
                isError = termsCode == InvoiceTermsCode.CUSTOM &&
                    customDueDate.isNotBlank() && !isValidNewInvoiceIsoDate(customDueDate),
                modifier = Modifier.weight(1f),
            )
        }

        AuntieSelectField(
            label = "Terms",
            options = invoiceTermsDefs(),
            selected = termsCode,
            onSelect = { termsCode = it },
            optionLabel = { it.label },
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(termsNote, style = AuntieTheme.typography.bodySmall, color = c.textDim)

        if (quoteMode) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Send to kinfolk now",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                AuntieToggle(checked = sendToKinfolk, onCheckedChange = { sendToKinfolk = it })
            }
        }

        // The disabled button's reason, not repeated when the terms note already says it.
        if (blocked != null && blocked != termsNote && !submitting) {
            Text(blocked, style = AuntieTheme.typography.bodySmall, color = c.error)
        }

        if (!quoteMode) {
            Text(
                "Saved as a draft. Nothing reaches $householdLabel until you send it from the invoice.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/** Typed extra charges, and the whole-invoice discount. An extra charge is an ordinary line. */
@Composable
private fun ExtraChargesEditor(
    drafts: List<ComposerDraftLine>,
    onChange: (List<ComposerDraftLine>) -> Unit,
    invoiceDiscountText: String,
    onInvoiceDiscountChange: (String) -> Unit,
    enabled: Boolean,
) {
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Extra charges", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        drafts.forEachIndexed { index, draft ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                BottomBorderField(
                    value = draft.description,
                    onValueChange = { onChange(drafts.replacedAt(index, draft.copy(description = it))) },
                    label = "What is this charge",
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BottomBorderField(
                        value = draft.qtyText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(qtyText = it))) },
                        label = "Qty",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                    BottomBorderField(
                        value = draft.unitText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(unitText = it))) },
                        label = "Each ($)",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                    BottomBorderField(
                        value = draft.discountText,
                        onValueChange = { onChange(drafts.replacedAt(index, draft.copy(discountText = it))) },
                        label = "Less ($)",
                        enabled = enabled,
                        keyboardType = KeyboardType.Decimal,
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
        GhostButton(label = "Add an extra charge", onClick = { onChange(drafts + ComposerDraftLine()) }, enabled = enabled)
        BottomBorderField(
            value = invoiceDiscountText,
            onValueChange = onInvoiceDiscountChange,
            label = "Discount off the whole invoice ($)",
            enabled = enabled,
            keyboardType = KeyboardType.Decimal,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun List<ComposerDraftLine>.replacedAt(index: Int, value: ComposerDraftLine): List<ComposerDraftLine> =
    mapIndexed { i, existing -> if (i == index) value else existing }
