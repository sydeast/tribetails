package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.noticePreviewSentence
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton

/** #1609: which household send a confirm is for. */
enum class HouseholdSend(val wire: String) { REMINDER("reminder"), REVIEW_SEND("reviewSend") }

/**
 * What the confirm says the send does. #1872: only what really happens. Review
 * and send sends the draft and marks the invoice open; it does not touch the
 * household's account credit, and the words make no claim about a payment.
 */
fun sendConfirmBodyText(send: HouseholdSend, quote: Boolean = false): String =
    if (quote && send == HouseholdSend.REVIEW_SEND) {
        // #2087: a quote saved unsent goes out through the draft send, as a quote.
        SEND_QUOTE_CONFIRM_TEXT
    } else if (send == HouseholdSend.REMINDER) {
        "This sends a real payment-reminder notification to the household."
    } else {
        "This sends the draft to the household and marks the invoice open. A draft missing its " +
            "total, household, or invoice number is rejected rather than sent."
    }

/**
 * #1609: the confirm before a household send. The walk's confirms said "the
 * household on file"; this names the person and each channel, read through
 * `previewInvoiceNotice` (the same recipient, prefs and gate the send uses).
 * Same copy as admin web and admin Android.
 */
@Composable
internal fun SendConfirmDialog(
    client: FirestoreClient,
    invoiceId: String,
    send: HouseholdSend,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    /** #2087: the draft being sent is a quote saved unsent. */
    quote: Boolean = false,
) {
    val c = AuntieTheme.colors
    var preview by remember(invoiceId, send) { mutableStateOf<String?>(null) }
    LaunchedEffect(invoiceId, send) {
        preview = when (val r = client.previewInvoiceNotice(invoiceId, send.wire)) {
            is WriteResult.Ok -> noticePreviewSentence(r.value)
            is WriteResult.Err -> "Couldn't check who this reaches: ${r.message}"
        }
    }
    AuntieDialog(
        visible = true,
        title = when {
            send == HouseholdSend.REMINDER -> "Send a payment reminder?"
            quote -> "Send this quote?"
            else -> "Send this draft?"
        },
        onDismiss = onDismiss,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(
                label = when {
                    send == HouseholdSend.REMINDER -> "Send reminder"
                    quote -> "Send quote"
                    else -> "Review and send"
                },
                onClick = onConfirm,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                sendConfirmBodyText(send, quote),
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Text(
                preview ?: "Checking who this reaches…",
                style = AuntieTheme.typography.bodySmall,
                color = c.textPrimary,
            )
        }
    }
}
