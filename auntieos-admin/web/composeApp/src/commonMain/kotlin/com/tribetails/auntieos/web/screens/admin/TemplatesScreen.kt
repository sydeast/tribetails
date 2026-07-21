package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker

/**
 * The two tabs of the merged Templates admin surface (Decision 2, 2026-06-02):
 *  - [Bank] authors the email templates SendGrid delivers.
 *  - [Assignment] binds each template to the notification trigger that fires it.
 *
 * [slug] is the URL detail segment ("#/templates/<slug>") and the back-compat
 * landing tab for the legacy standalone slugs.
 */
enum class TemplatesTab(val slug: String, val label: String) {
    Bank("bank", "Bank"),
    Assignment("assignment", "Assignment"),
}

/** Resolve a tab from a URL detail segment / legacy slug; defaults to [TemplatesTab.Bank]. */
fun templatesTabFromSlug(slug: String?): TemplatesTab =
    TemplatesTab.entries.firstOrNull { it.slug.equals(slug, ignoreCase = true) } ?: TemplatesTab.Bank

/**
 * Merged Templates screen: one destination, two tabs (Decision 2). The Template
 * Bank and Template Assignment surfaces, previously two separate nav entries, now
 * live behind a single segmented control sharing one scaffold. Each tab still owns
 * its own heading + actions (New template / Add Binding) via the reused
 * [TemplateBankBody] / [TemplateAssignmentBody].
 *
 * [initialTab] seeds the active tab from the route; [onTabChange] reports the
 * user's tab switches back to the shell so the browser hash can reflect it.
 */
@Composable
fun TemplatesScreen(
    initialTab: TemplatesTab = TemplatesTab.Bank,
    onTabChange: (TemplatesTab) -> Unit = {},
    templateService: TemplateService = remember { TemplateService() },
) {
    // Seeded by the route; resets only when the inbound route tab actually changes.
    var tab by remember(initialTab) { mutableStateOf(initialTab) }

    ScreenScaffold {
        SegmentedPicker(
            options = TemplatesTab.entries,
            selected = tab,
            onSelect = {
                tab = it
                onTabChange(it)
            },
            label = { it.label },
        )
        Spacer(Modifier.height(20.dp))
        when (tab) {
            TemplatesTab.Bank -> TemplateBankBody(templateService)
            TemplatesTab.Assignment -> TemplateAssignmentBody(templateService)
        }
    }
}
