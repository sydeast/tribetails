package com.kinfolk.portal.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.theme.KinfolkSpacing

/**
 * #2356, #2259: an invoice link that leads to nothing the household can open: an
 * unsent draft (hidden from Kinfolk), or an invoice since removed. A tapped
 * push or a row on the notifications list can name one. The web portal says
 * "We couldn't find that invoice"; this is the same answer here, where the
 * screen used to show a spinner that never ended. Same shape as "Kin not
 * found" (screens/kin/KinScreen.kt).
 */
/** What the invoice detail route draws. */
enum class InvoiceDetailView { Invoice, Loading, Missing, Failed }

/**
 * #2356: "not found" is said only about a FRESH read. The invoices list is
 * loaded once and kept, so an invoice sent after that load is absent from it
 * without being gone: the route reads again first ([freshlyRead]). A read
 * that failed proves nothing about the invoice either, so it never reads as
 * missing: it reads as failed, with a way to try again, once the read is over.
 * The spinner is only ever drawn while a read is out. Pure; unit-tested.
 */
fun invoiceDetailView(found: Boolean, freshlyRead: Boolean, readFailed: Boolean): InvoiceDetailView = when {
    found -> InvoiceDetailView.Invoice
    !freshlyRead -> InvoiceDetailView.Loading
    readFailed -> InvoiceDetailView.Failed
    else -> InvoiceDetailView.Missing
}

@Composable
fun InvoiceMissing(onBackToInvoices: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().testTag("invoice-missing"),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "Invoices")
        EmptyState(
            title = "Invoice not found",
            message = "This invoice is no longer available.",
            actionLabel = "Back to Invoices",
            onAction = onBackToInvoices,
        )
    }
}

/** #2356: the invoices could not be read at all (offline, or the server refused). Not the same as gone. */
@Composable
fun InvoiceReadFailed(onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().testTag("invoice-read-failed"),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "Invoices")
        EmptyState(
            title = "Couldn't load this invoice",
            message = "Check your connection and try again.",
            actionLabel = "Try again",
            onAction = onRetry,
        )
    }
}
