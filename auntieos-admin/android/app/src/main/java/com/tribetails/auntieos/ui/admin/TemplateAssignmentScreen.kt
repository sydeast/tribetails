package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Workflow
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.data.repository.isOverridden
import com.tribetails.auntieos.data.repository.resolvedTemplateMissing
import com.tribetails.auntieos.data.repository.routingSource
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Template routing in the Den aesthetic, the Android twin of the web
 * `TemplateAssignments.tsx`.
 *
 * WHAT THIS SCREEN SHOWS, and why it changed (issue #384). It used to lead with a
 * "Bindings" list, which is the `notificationTemplateBindings` collection. On the
 * 2026-08-17 walk that collection was empty, and the operator called it: "current
 * bindings being empty is false as some templates are already being sent out."
 *
 * They were right. Routing happens by NAME. `lib/sendFromTemplate.ts` looks for
 * `notificationTemplateBindings/{catalogKey}` and, finding nothing, falls through
 * to `emailTemplates/{catalogKey}`. Every catalog row has `templates.email === key`,
 * so every send today takes that fallback. A binding is an OVERRIDE on top of a
 * system that already works, and an empty override layer is not an empty routing
 * table.
 *
 * So the list is now the routing table: every catalog key, the template that renders
 * it right now, and which of the two put it there. A key whose resolved template
 * document is missing is called out loudly, because it throws `email template
 * missing` on its next send.
 *
 * Two limits stated rather than implied, matching the web wording:
 *  - An override applies to EMAIL only. `senders/smsChannel.ts` and
 *    `senders/pushChannel.ts` read the template ids frozen in the catalog and never
 *    call `resolveTemplateId`.
 *  - The binding's `audience` is written, read back, and consulted by no sender.
 *
 * The catalog key is never typed here either. Every editable row comes from
 * listCatalogKeys, so the typo that issue #382 was about cannot be entered at all.
 */

// Verbatim audience list from source (kinfolk, auntie, admin, guest). Single-select,
// nullable: clicking the selected one clears it back to null.
private val AUDIENCES = listOf("kinfolk", "auntie", "admin", "guest")

/**
 * Pure: the triggerKey to echo as a genuine override, or null when there is none.
 * The server (assignTemplate) defaults a blank triggerKey to the catalogKey, so an
 * echo only makes sense when triggerKey is present AND differs from catalogKey.
 * Mirrors the web TemplateAssignmentScreen guard. Unit-tested.
 */
internal fun genuineTriggerOverride(triggerKey: String?, catalogKey: String): String? =
    triggerKey?.takeIf { it.isNotBlank() && it != catalogKey }

/** The row being edited: the catalog key, plus its binding when it already has one. */
private data class EditTarget(
    val row: TemplateRepository.CatalogKey,
    val binding: TemplateRepository.TemplateBinding?,
)

/**
 * Standalone Template Routing screen. Kept for direct use; the merged two-tab
 * [TemplatesScreen] renders [TemplateAssignmentBody] inside its shared scaffold.
 */
@Composable
fun TemplateAssignmentScreen(
    onBack: () -> Unit,
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    AuntieScreenScaffold(title = "Template Routing", onBack = onBack) {
        TemplateAssignmentBody(templateRepo)
    }
}

/** Template routing content without the outer scaffold (see [TemplateAssignmentScreen]). */
@Composable
fun TemplateAssignmentBody(
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberCoroutineScope()
    var bindings by remember { mutableStateOf<List<TemplateRepository.TemplateBinding>>(emptyList()) }
    var templates by remember { mutableStateOf<List<TemplateRepository.EmailTemplate>>(emptyList()) }
    // The routing table itself. Comes from listCatalogKeys, so a bindings failure
    // cannot make it wrong; it only costs the audience line and the editor's start.
    var catalogRows by remember { mutableStateOf<List<TemplateRepository.CatalogKey>>(emptyList()) }
    var catalogError by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    // Two distinct read-error channels so a bindings failure and a templates failure
    // are never conflated: a listTemplates error must not coexist silently with a
    // populated routing table, and a recovered call drops its own stale banner.
    var bindingsError by remember { mutableStateOf<String?>(null) }
    var templatesError by remember { mutableStateOf<String?>(null) }
    // Write-path error from assignTemplate, surfaced loudly and dismissable.
    var saveError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<EditTarget?>(null) }
    // Client-side search over the loaded routing table. Pure in-memory filter;
    // touches no callable or data wiring.
    var query by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        // Clear all channels up front so a recovered call drops its stale banner.
        bindingsError = null
        templatesError = null
        catalogError = null
        templateRepo.listBindings()
            .onSuccess { bindings = it }
            .onFailure { bindingsError = it.message ?: "Could not load bindings." }
        templateRepo.listTemplates()
            .onSuccess { templates = it }
            .onFailure { templatesError = it.message ?: "Could not load templates." }
        templateRepo.listCatalogKeys()
            .onSuccess { catalogRows = it }
            .onFailure { catalogError = it.message ?: "Could not load catalog keys." }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    val bindingByKey = bindings.associateBy { it.catalogKey }
    val templateTitles = templates.associate { it.templateId to it.title }
    val bankIds = templates.map { it.templateId }.toSet()
    val bankLoaded = !loading && templatesError == null && templates.isNotEmpty()
    val overrideCount = catalogRows.count { isOverridden(it) }
    val brokenCount = catalogRows.count { resolvedTemplateMissing(it, bankIds, bankLoaded) }
    val templatesMissing = !loading && templatesError == null && templates.isEmpty()

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space4),
            modifier = Modifier.fillMaxSize(),
        ) {
            item {
                DenScreenHeading(
                    kicker = "The Den · Admin",
                    title = "Template",
                    accentTail = "Routing.",
                    subtitle = "Every catalog key already sends a template. A binding is an override on top of that.",
                )
            }

            // Fail-loud: surface each callable error inline rather than swallowing it.
            bindingsError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Could not load bindings",
                        icon = Lucide.Workflow,
                        onDismiss = { bindingsError = null },
                    ) {
                        Text(
                            "$msg Each key's resolved template below is still correct, but the audience recorded on an override is not shown and the editor opens without it.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }
            templatesError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Could not load templates",
                        icon = Lucide.Workflow,
                        onDismiss = { templatesError = null },
                    ) {
                        Text(
                            "$msg Rows show template ids instead of titles until templates load, and an override cannot be saved.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }
            saveError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Save failed",
                        icon = Lucide.Workflow,
                        onDismiss = { saveError = null },
                    ) {
                        Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    }
                }
            }
            // Templates loaded but empty (no error): warn loudly, since the editor's
            // template picker would otherwise be an unselectable dead end.
            if (templatesMissing) {
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "No email templates found",
                        icon = Lucide.Workflow,
                    ) {
                        Text(
                            "The Template Bank is empty, so no override can be saved until at least one template exists.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }

            // Catalog read error surfaces loudly and separately: without it there is
            // no routing table at all, which is a different failure from the two above.
            catalogError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Could not load the routing table",
                        icon = Lucide.Workflow,
                        onDismiss = { catalogError = null },
                    ) {
                        Text(
                            "$msg Nothing below is trustworthy until this loads.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }

            item {
                DenPanel(
                    title = "What each key sends today",
                    subtitle = "Every catalog key, the template that renders it right now, and where that choice came from.",
                    trailing = {
                        if (!loading && catalogRows.isNotEmpty()) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                            ) {
                                AuntieStatusPill(
                                    label = "Override $overrideCount",
                                    tone = AuntieStatusTone.Success,
                                    showDot = true,
                                )
                                AuntieStatusPill(
                                    label = "By name ${catalogRows.size - overrideCount}",
                                    tone = AuntieStatusTone.Muted,
                                    showDot = true,
                                )
                            }
                        }
                    },
                ) {
                    when {
                        loading -> EmptyHint("Loading the routing table…")
                        catalogRows.isEmpty() -> EmptyHint(
                            "listCatalogKeys returned no keys. The catalog is compiled into the backend, so treat this as a broken deploy rather than an empty setup.",
                        )
                        else -> {
                            Text(
                                buildString {
                                    append("${catalogRows.size} keys route today. ")
                                    append("$overrideCount of them through an override, the rest by name.")
                                    if (brokenCount > 0) {
                                        val phrase = if (brokenCount == 1) "1 key resolves" else "$brokenCount keys resolve"
                                        append(" $phrase to a template document that does not exist and will throw on the next send.")
                                    }
                                },
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textDim,
                            )
                            Spacer(Modifier.height(dims.space3))

                            AuntieSearchField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = "Search by catalog key, name or template...",
                                onClear = { query = "" },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Spacer(Modifier.height(dims.space3))

                            val visible = if (query.isBlank()) {
                                catalogRows
                            } else {
                                val q = query.trim().lowercase()
                                catalogRows.filter {
                                    it.key.lowercase().contains(q) ||
                                        it.label.lowercase().contains(q) ||
                                        it.resolvedTemplateId.lowercase().contains(q)
                                }
                            }

                            if (visible.isEmpty()) {
                                EmptyHint("No catalog keys match \"${query.trim()}\".")
                            } else {
                                Column(
                                    verticalArrangement = Arrangement.spacedBy(dims.space2),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    visible.forEach { row ->
                                        RoutingRow(
                                            row = row,
                                            binding = bindingByKey[row.key],
                                            templateTitle = templateTitles[row.resolvedTemplateId],
                                            missing = resolvedTemplateMissing(row, bankIds, bankLoaded),
                                            onEdit = {
                                                selected = EditTarget(row, bindingByKey[row.key])
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(dims.space4))
                    AuntieNoteCallout(
                        text = "An override changes the EMAIL template only. SMS and push read the template ids frozen in the catalog and never look at a binding. Audience is written to the binding and no sender reads it, so it records intent and changes nothing.",
                    )
                }
            }
        }

    selected?.let { target ->
        BindingEditorDialog(
            target = target,
            templates = templates,
            onDismiss = { selected = null },
            // AO-56: remove the override via unassignTemplate. Null when the key has
            // no binding doc yet, so the button only shows where there is something
            // to remove.
            onUnassign = if (!target.row.bound) null else {
                {
                    scope.launch {
                        templateRepo.unassignTemplate(target.row.key)
                            .onSuccess {
                                selected = null
                                saveError = null
                                reload()
                            }
                            .onFailure { saveError = it.message ?: "Removing the override failed." }
                    }
                }
            },
            onSave = { updated ->
                scope.launch {
                    templateRepo
                        .assignTemplate(
                            catalogKey = updated.catalogKey,
                            templateId = updated.templateId,
                            audience = updated.audience,
                            triggerKey = updated.triggerKey,
                            active = updated.active,
                        )
                        .onSuccess {
                            selected = null
                            saveError = null
                            reload()
                        }
                        .onFailure { saveError = it.message ?: "Assign failed." }
                }
            },
        )
    }
}

/**
 * One catalog key as a Den entity row: the dotted key is the title, the "sends X"
 * line plus where that came from sit in the subtitle, and a missing template document
 * is spelled out rather than left to the reader. An OVERRIDE / BY NAME pill and an
 * Edit ghost button trail.
 */
@Composable
private fun RoutingRow(
    row: TemplateRepository.CatalogKey,
    binding: TemplateRepository.TemplateBinding?,
    templateTitle: String?,
    missing: Boolean,
    onEdit: () -> Unit,
) {
    val dims = AuntieTheme.dims

    // triggerKey override echo (always on): only renders for a GENUINE override
    // (triggerKey present AND different from catalogKey). The server defaults a blank
    // triggerKey to the catalogKey, so this guard stops it firing on every binding.
    val genuineOverride = genuineTriggerOverride(binding?.triggerKey, row.key)

    val subtitle = buildString {
        append("sends ${templateTitle ?: row.resolvedTemplateId}")
        append("\n${routingSource(row)}")
        binding?.audience?.let { append("\nAudience: $it (stored, no sender reads it)") }
        genuineOverride?.let { append("\noverride: $it") }
        if (missing) {
            append("\nNo emailTemplates/${row.resolvedTemplateId} document. This key throws \"email template missing\" on its next send.")
        }
    }

    AuntieEntityRow(
        title = row.key,
        subtitle = subtitle,
        leading = {
            AuntieIconTile(icon = Lucide.Workflow, tone = AuntieStatusTone.Purple, size = 38.dp)
        },
        trailing = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                AuntieStatusPill(
                    label = if (isOverridden(row)) "OVERRIDE" else "BY NAME",
                    tone = if (isOverridden(row)) AuntieStatusTone.Success else AuntieStatusTone.Muted,
                    mono = true,
                )
                GhostButton(label = if (row.bound) "Edit" else "Override", onClick = onEdit)
            }
        },
        showDivider = true,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BindingEditorDialog(
    target: EditTarget,
    templates: List<TemplateRepository.EmailTemplate>,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.TemplateBinding) -> Unit,
    // AO-56: only where a binding doc exists. Null when the key routes by name.
    onUnassign: (() -> Unit)? = null,
) {
    val row = target.row
    val binding = target.binding
    // Seeded from what the key sends TODAY rather than from blank, so opening a
    // by-name key and saving records the template it already uses.
    var templateId by remember(row.key) { mutableStateOf(binding?.templateId ?: row.resolvedTemplateId) }
    var audience by remember(row.key) { mutableStateOf(binding?.audience) }
    var triggerKey by remember(row.key) { mutableStateOf(binding?.triggerKey ?: "") }
    var active by remember(row.key) { mutableStateOf(binding?.active ?: true) }
    // Two-tap confirm for the destructive removal, rather than a second nested
    // dialog (two AuntieDialogs would fight over dismiss/back).
    var confirmingUnassign by remember(row.key) { mutableStateOf(false) }
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    AuntieDialog(
        visible = true,
        title = if (row.bound) "Edit override: ${row.key}" else "Override: ${row.key}",
        onDismiss = onDismiss,
        maxWidth = 560.dp,
        closeIcon = Lucide.X,
        leadingIcon = {
            AuntieIconTile(icon = Lucide.Workflow, tone = AuntieStatusTone.Purple, size = 38.dp)
        },
        hint = "Without an override this key sends emailTemplates/${row.defaultTemplateId}, matched by name. Saving here points it somewhere else, for email only.",
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
            if (onUnassign != null) {
                GhostButton(
                    // First tap arms, second tap removes: a lightweight confirm on a
                    // change that alters what dispatch sends.
                    label = if (confirmingUnassign) "Confirm remove" else "Remove override",
                    onClick = {
                        if (confirmingUnassign) onUnassign() else confirmingUnassign = true
                    },
                    modifier = Modifier.weight(1f),
                )
            }
            PrimaryButton(
                label = "Save",
                // The catalog key comes from the table, so only the template can be
                // unset. Save enables once one is chosen.
                enabled = templateId.isNotBlank(),
                onClick = {
                    onSave(
                        TemplateRepository.TemplateBinding(
                            catalogKey = row.key,
                            templateId = templateId,
                            audience = audience,
                            triggerKey = triggerKey.ifBlank { null },
                            active = active,
                        ),
                    )
                },
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        // The catalog key is never typed. It is the binding doc id and it comes from
        // the routing table, which is what makes the misspelling in issue #382
        // unenterable on this screen.
        AuntieFieldLabel(text = "Catalog Key")
        Text(
            row.key,
            style = AuntieTheme.typography.mono.copy(fontSize = 14.sp),
            color = c.textPrimary,
            modifier = Modifier.padding(top = dims.space1, bottom = dims.space1),
        )
        AuntieNoteCallout(
            text = "Catalog key is the binding's identity and cannot be changed here. To route a different key, close this and open that key's row.",
        )

        // Template selector: one selectable chip per EmailTemplate (title + optional
        // category line). Selected chip washes the brand accent. If no templates
        // loaded, the picker would be empty, so fail loud instead.
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Template")
            if (templates.isEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "No templates to choose from",
                ) {
                    Text(
                        "No email templates loaded, so this override cannot be saved. Add a template in the Template Bank first.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space1)) {
                    templates.forEach { tpl ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            AuntieChip(
                                selected = tpl.templateId == templateId,
                                onClick = { templateId = tpl.templateId },
                                label = tpl.title,
                            )
                            tpl.category?.let { cat ->
                                Text(
                                    cat,
                                    style = AuntieTheme.typography.labelSmall,
                                    color = c.textDim,
                                )
                            }
                        }
                    }
                }
            }
        }

        // Audience pills: single-select; clicking the selected one clears it (nullable).
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Audience (stored, unused)")
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                AUDIENCES.forEach { a ->
                    val isSelected = a == audience
                    AuntieChip(
                        selected = isSelected,
                        onClick = { audience = if (isSelected) null else a },
                        label = a,
                    )
                }
            }
        }

        BottomBorderField(
            value = triggerKey,
            onValueChange = { triggerKey = it },
            label = "Trigger Key (optional override)",
            modifier = Modifier.fillMaxWidth(),
        )

        // active toggle + "Active" / "Paused" label. A paused override falls back to
        // the name-matched default, which is what resolveTemplateId does at send time.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            AuntieToggle(checked = active, onCheckedChange = { active = it })
            Text(
                if (active) "Active" else "Paused, sends the name-matched default",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
    }
}
