package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.SegmentedPicker

/**
 * The tabs of the merged Templates admin surface (Decision 2, 2026-06-02):
 *  - [Bank] authors the email templates SendGrid delivers.
 *  - [Assignment] binds each template to the notification trigger that fires it.
 *  - [Import] loads the templates committed to the repo (issue #468).
 *
 * Mirrors the web `TemplatesTab` so both platforms stay symmetric.
 */
enum class TemplatesTab(val slug: String, val label: String) {
    Bank("bank", "Bank"),
    Assignment("assignment", "Assignment"),
    /**
     * Issue #468: loading the repo's notification templates used to be a
     * terminal command, and the operator ruled that out. It is a tab now,
     * matching the React admin's Import from repo view.
     */
    Import("import", "Import"),
}

/** Resolve a tab from a slug; defaults to [TemplatesTab.Bank]. */
fun templatesTabFromSlug(slug: String?): TemplatesTab =
    TemplatesTab.entries.firstOrNull { it.slug.equals(slug, ignoreCase = true) } ?: TemplatesTab.Bank

/**
 * Merged Templates screen: one destination, several tabs (Decision 2). Template
 * Bank and Template Assignment, previously two separate nav entries, share one
 * top bar with a [SegmentedPicker] switching between the reused
 * [TemplateBankBody], [TemplateAssignmentBody] and [TemplateImportBody]. Each
 * tab still owns its own heading and actions.
 */
@Composable
fun TemplatesScreen(
    onBack: () -> Unit,
    initialTab: TemplatesTab = TemplatesTab.Bank,
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    var tab by remember(initialTab) { mutableStateOf(initialTab) }
    AuntieScreenScaffold(title = "Templates", onBack = onBack) {
        SegmentedPicker(
            options = TemplatesTab.entries.toList(),
            selected = tab,
            onSelect = { tab = it },
            label = { it.label },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tab) {
                TemplatesTab.Bank -> TemplateBankBody(templateRepo)
                TemplatesTab.Assignment -> TemplateAssignmentBody(templateRepo)
                TemplatesTab.Import -> TemplateImportBody(templateRepo)
            }
        }
    }
}
