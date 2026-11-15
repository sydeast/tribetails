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
