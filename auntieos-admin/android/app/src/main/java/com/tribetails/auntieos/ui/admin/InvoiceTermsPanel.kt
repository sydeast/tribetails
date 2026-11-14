package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.domain.PAYMENT_TERMS_SETTING_CODES
import com.tribetails.auntieos.domain.paymentTermsSettingOf
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton

/**
 * #1966: Settings > Invoices > Payment terms, the terms every new invoice
 * starts on (operator ruling 2026-11-12), the same panel the web shows under
 * Payments (`settings/InvoiceTermsSection.tsx`). The ruled options in the ruled
 * order, starting on due on receipt. New invoice starts on it, and a quote
 * turned into an invoice and any invoice the server raises are dated by it.
 * Saved alone: the diff sends only `invoicePaymentTerms`, and
 * `saveBusinessSettings` checks it against the same list. A refusal shows in
 * the screen's "Not saved" banner.
 */
@Composable
internal fun InvoiceTermsPanel(
    settings: BusinessSettings,
    saving: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
) {
    val saved = paymentTermsSettingOf(settings.invoicePaymentTerms)
    // Re-seeded only when the SAVED value changes (a load, or this panel's own save).
    var draft by remember(saved) { mutableStateOf(saved) }
    val dirty = draft != saved
    DenPanel(title = "Invoices") {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieDropdownField(
                value = draft,
                options = PAYMENT_TERMS_SETTING_CODES,
                onSelect = { draft = it },
                displayText = { it.label },
                label = "Payment terms",
                enabled = !saving,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
                GhostButton(
                    label = "Cancel",
                    onClick = { draft = saved },
                    enabled = dirty && !saving,
                    modifier = Modifier.weight(1f),
                )
                PrimaryButton(
                    label = "Save payment terms",
                    // The button turns into a spinner for the wait (PrimaryButton `loading`).
                    onClick = { if (dirty && !saving) onSettingsChange(settings.withPaymentTerms(draft)) },
                    modifier = Modifier.weight(1f),
                    enabled = dirty && !saving,
                    loading = saving,
                )
            }
        }
    }
}

/** #1966: the settings with only the Payment terms changed, as its wire code. */
internal fun BusinessSettings.withPaymentTerms(code: InvoiceTermsCode): BusinessSettings =
    copy(invoicePaymentTerms = code.wire)
