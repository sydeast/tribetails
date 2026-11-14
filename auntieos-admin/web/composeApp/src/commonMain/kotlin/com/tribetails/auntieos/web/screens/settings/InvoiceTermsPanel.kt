package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.screens.invoices.InvoiceTermsCode
import com.tribetails.auntieos.web.screens.invoices.PAYMENT_TERMS_SETTING_CODES
import com.tribetails.auntieos.web.screens.invoices.paymentTermsSettingOf
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

/**
 * #1966: Settings > Invoices > Payment terms on the desktop console, the same
 * panel the web shows under Payments (`settings/InvoiceTermsSection.tsx`). The
 * ruled options in the ruled order, starting on due on receipt; New invoice
 * starts on it. Saved through `saveBusinessSettings`, whose diff sends only
 * `invoicePaymentTerms`; a refusal shows in the screen's save error line.
 */
@Composable
internal fun InvoiceTermsPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    save: suspend (BusinessSettings) -> Unit,
) {
    val dims = AuntieTheme.dims
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val saved = paymentTermsSettingOf(settingsData?.invoicePaymentTerms)
    // Re-seeded only when the SAVED value changes (a load, or this panel's own save).
    var draft by remember(saved) { mutableStateOf(saved) }
    var saving by remember { mutableStateOf(false) }
    val dirty = draft != saved
    val editable = settingsLoaded && !saving
    DenPanel(title = "Invoices") {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieSelectField(
                label = "Payment terms",
                options = PAYMENT_TERMS_SETTING_CODES,
                selected = draft,
                onSelect = { draft = it },
                optionLabel = { it.label },
                enabled = editable,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                GhostButton(label = "Cancel", enabled = editable && dirty, onClick = { draft = saved })
                PrimaryButton(
                    // `loading` turns the button into a spinner for the write.
                    label = if (settingsLoaded) "Save payment terms" else "Loading settings…",
                    enabled = editable && dirty,
                    loading = saving,
                    onClick = {
                        val loaded = settingsData ?: return@PrimaryButton
                        if (saving || !dirty) return@PrimaryButton
                        saving = true
                        scope.launch {
                            try {
                                save(loaded.withPaymentTerms(draft))
                            } finally {
                                saving = false
                            }
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** #1966: the settings with only the Payment terms changed, as its wire code. */
internal fun BusinessSettings.withPaymentTerms(code: InvoiceTermsCode): BusinessSettings =
    copy(invoicePaymentTerms = code.wire)
