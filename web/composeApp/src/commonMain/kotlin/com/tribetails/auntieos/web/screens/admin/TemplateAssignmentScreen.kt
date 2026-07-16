package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Workflow
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.computeUnboundCatalogKeys
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

// Verbatim audience list from source (kinfolk, auntie, admin, guest). Single-select,
// nullable: clicking the selected one clears it back to null.
private val AUDIENCES = listOf("kinfolk", "auntie", "admin", "guest")

/**
 * The "override: {triggerKey}" echo only renders for a GENUINE override: the stored
 * triggerKey is present, non-blank, AND differs from the catalogKey. The server
 * (MyTribe assignTemplate) defaults a blank triggerKey to the catalogKey, so this
 * guard keeps an echo from firing on every binding. Pure, so it is unit-tested
 * directly (mirrors the Android helper).
 */
internal fun genuineTriggerOverride(triggerKey: String?, catalogKey: String): String? =
    triggerKey?.takeIf { it.isNotBlank() && it != catalogKey }

// The per-card "override: {triggerKey}" echo only renders when the stored
// triggerKey is a genuine override (differs from catalogKey). The server (MyTribe
// assignTemplate) defaults a blank triggerKey to the catalogKey, so the guard
// keeps an unguarded echo from firing on every binding.
//
// The "unbound catalog keys" hint is wired to the listCatalogKeys callable: it
// shows catalog keys that have no template binding yet (computeUnboundCatalogKeys
// diffs the catalog set against the bound set). Fail-loud on load error.

/**
 * Standalone Template Assignment screen. Kept for the desktop screenshot harness;
 * the merged two-tab [TemplatesScreen] renders [TemplateAssignmentBody] directly
 * inside its shared scaffold.
 */
@Composable
fun TemplateAssignmentScreen(
    templateService: TemplateService = remember { TemplateService() },
) {
    ScreenScaffold { TemplateAssignmentBody(templateService) }
}

/**
 * Template Assignment content WITHOUT the outer [ScreenScaffold]. Renders inside
 * either the standalone screen above or the merged [TemplatesScreen]'s scaffold.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TemplateAssignmentBody(
    templateService: TemplateService = remember { TemplateService() },
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()
    var bindings by remember { mutableStateOf<List<TemplateService.TemplateBinding>>(emptyList()) }
    var templates by remember { mutableStateOf<List<TemplateService.EmailTemplate>>(emptyList()) }
    var catalogKeys by remember { mutableStateOf<List<String>>(emptyList()) }
    var catalogKeysError by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    // Two distinct error channels so a bindings failure and a templates failure are
    // not conflated. The old single `error` var let a listTemplates Err coexist with
    // a populated bindings list and never cleared a stale bindings error.
    var bindingsError by remember { mutableStateOf<String?>(null) }
    var templatesError by remember { mutableStateOf<String?>(null) }
    // Write-path error from assignTemplate (surfaced loudly, dismissable).
    var saveError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<TemplateService.TemplateBinding?>(null) }
    // SUGGESTION: client-side search over the binding list. Filters the already-loaded
    // bindings and never alters any callable or data wiring. // SUGGESTION
    var query by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        // Clear both channels up front so a recovered call drops its stale banner.
        bindingsError = null
        templatesError = null
        when (val r = templateService.listBindings()) {
            is WriteResult.Ok -> bindings = r.value
            is WriteResult.Err -> bindingsError = r.message
        }
        when (val r = templateService.listTemplates()) {
            is WriteResult.Ok -> templates = r.value
            is WriteResult.Err -> templatesError = r.message
        }
        catalogKeysError = null
        when (val r = templateService.listCatalogKeys()) {
            is WriteResult.Ok -> catalogKeys = r.value
            is WriteResult.Err -> catalogKeysError = r.message
        }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    val activeCount = bindings.count { it.active }
    val pausedCount = bindings.size - activeCount
    val templatesMissing = !loading && templatesError == null && templates.isEmpty()

    Column(Modifier.fillMaxWidth()) {
        DenScreenHeading(
            kicker = "The Den · Admin",
            title = "Template",
            accentTail = "Assignment.",
            subtitle = "Bind email templates to notification triggers.",
        )
        Spacer(Modifier.height(20.dp))

        // Fail-loud: surface each callable error inline rather than swallowing it.
        bindingsError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load bindings",
                icon = Lucide.Workflow,
                onDismiss = { bindingsError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
        }
        templatesError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load templates",
                icon = Lucide.Workflow,
                onDismiss = { templatesError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "$msg The template picker and Add Binding stay disabled until templates load.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        saveError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Save failed",
                icon = Lucide.Workflow,
                onDismiss = { saveError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
        }
        // Templates loaded but empty (no error): warn loudly, since the editor's
        // template picker would otherwise be an unselectable dead end.
        if (templatesMissing) {
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                title = "No email templates found",
                icon = Lucide.Workflow,
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "Add Binding is disabled until at least one email template exists in the Template Bank.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }

        // Unbound catalog keys hint: catalog keys (listCatalogKeys) that have no
        // binding yet. Real, fail-loud: a load error surfaces; an empty set means
        // every catalog key is bound.
        catalogKeysError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load catalog keys",
                icon = Lucide.Workflow,
                onDismiss = { catalogKeysError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
        }
        if (!loading && catalogKeysError == null && catalogKeys.isNotEmpty()) {
            val unbound = computeUnboundCatalogKeys(catalogKeys, bindings.map { it.catalogKey }.toSet())
            if (unbound.isNotEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "${unbound.size} unbound catalog ${if (unbound.size == 1) "key" else "keys"}",
                    icon = Lucide.Workflow,
                    modifier = Modifier.padding(bottom = dims.space3),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                        Text(
                            "These catalog keys have no template binding yet, so they fall back to catalog defaults:",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            unbound.forEach { key ->
                                AuntieChip(label = key, selected = false, onClick = {}, tone = AuntieChipTone.Orange)
                            }
                        }
                    }
                }
            }
        }

        DenPanel(
            title = "Bindings",
            subtitle = "Each catalog key maps to one email template, with an optional audience and trigger override.",
            trailing = {
                if (!loading && bindings.isNotEmpty()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        AuntieStatusPill(
                            label = "Active $activeCount",
                            tone = AuntieStatusTone.Success,
                            showDot = true,
                        )
                        AuntieStatusPill(
                            label = "Paused $pausedCount",
                            tone = AuntieStatusTone.Muted,
                            showDot = true,
                        )
                    }
                }
            },
        ) {
            when {
                loading -> EmptyHint("Loading bindings…")
                bindings.isEmpty() -> AuntieEmptyState(
                    title = "No bindings yet",
                    message = "No bindings yet. Defaults from the catalog apply until you assign one.",
                    icon = Lucide.Workflow,
                    compact = true,
                )
                else -> {
                    // SUGGESTION: client-side search field over the loaded bindings.
                    // Pure in-memory filter; touches no callable. // SUGGESTION
                    AuntieSearchField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = "Search by catalog key or template...",
                        onClear = { query = "" },
                        modifier = Modifier.fillMaxWidth().widthIn(min = 240.dp),
                    )
                    Spacer(Modifier.height(dims.space3))

                    val visible = if (query.isBlank()) {
                        bindings
                    } else {
                        val q = query.trim().lowercase()
                        bindings.filter {
                            it.catalogKey.lowercase().contains(q) ||
                                it.templateId.lowercase().contains(q)
                        }
                    }

                    if (visible.isEmpty()) {
                        EmptyHint("No bindings match \"${query.trim()}\".")
                    } else {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(dims.space3),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            visible.forEach { binding ->
                                BindingCard(binding = binding, onEdit = { selected = binding })
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(dims.space4))
            // Add Binding is gated on having at least one template to assign. With an
            // empty templates list the editor's picker is unselectable and Save can
            // never enable, so the button stays disabled (see fail-loud banner above).
            val canAdd = templates.isNotEmpty()
            PrimaryButton(
                label = "Add Binding",
                enabled = canAdd && !loading,
                onClick = {
                    selected = TemplateService.TemplateBinding(
                        catalogKey = "",
                        templateId = templates.firstOrNull()?.templateId ?: "",
                        audience = null,
                        triggerKey = null,
                        active = true,
                    )
                },
            )
        }
    }

    selected?.let { current ->
        BindingEditorOverlay(
            binding = current,
            templates = templates,
            // catalogKey is the Firestore doc ID. On an existing binding it is
            // immutable here: editing it would orphan the old doc and create a new
            // one (no delete/unassign callable exists). The field is locked on edit.
            isNew = current.catalogKey.isBlank(),
            onDismiss = { selected = null },
            onSave = { updated ->
                scope.launch {
                    when (
                        val r = templateService.assignTemplate(
                            catalogKey = updated.catalogKey,
                            templateId = updated.templateId,
                            audience = updated.audience,
                            triggerKey = updated.triggerKey,
                            active = updated.active,
                        )
                    ) {
                        is WriteResult.Ok -> {
                            selected = null
                            saveError = null
                            reload()
                        }
                        is WriteResult.Err -> saveError = r.message
                    }
                }
            },
        )
    }
}

@Composable
private fun BindingCard(
    binding: TemplateService.TemplateBinding,
    onEdit: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    GlassSurface(cornerRadius = 16.dp) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // catalogKey is the card title; mono face since these are dotted keys.
                Text(
                    binding.catalogKey,
                    style = AuntieTheme.typography.mono.copy(fontSize = 15.sp),
                    color = c.textPrimary,
                )
                // ACTIVE / PAUSED pill, success when active, muted when paused.
                AuntieStatusPill(
                    label = if (binding.active) "ACTIVE" else "PAUSED",
                    tone = if (binding.active) AuntieStatusTone.Success else AuntieStatusTone.Muted,
                    mono = true,
                )
            }
            // "→ {templateId}" reproduced verbatim from source (a plain right arrow,
            // not an em dash).
            Text("→ ${binding.templateId}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            // Optional "Audience: {a}", only rendered when binding.audience != null.
            binding.audience?.let { a ->
                Text("Audience: $a", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            // triggerKey override echo. The server defaults a blank triggerKey to the
            // catalogKey, so this only renders for a GENUINE override (triggerKey present
            // AND different from catalogKey). Without that guard the line would fire on
            // every binding echoing the catalogKey.
            val genuineOverride = genuineTriggerOverride(binding.triggerKey, binding.catalogKey)
            if (genuineOverride != null) {
                Text("override: $genuineOverride", style = AuntieTheme.typography.bodySmall, color = c.accent)
            }
            Box(modifier = Modifier.padding(top = dims.space1)) {
                GhostButton(label = "Edit", onClick = onEdit)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BindingEditorOverlay(
    binding: TemplateService.TemplateBinding,
    templates: List<TemplateService.EmailTemplate>,
    isNew: Boolean,
    onDismiss: () -> Unit,
    onSave: (TemplateService.TemplateBinding) -> Unit,
) {
    var catalogKey by remember(binding.catalogKey) { mutableStateOf(binding.catalogKey) }
    var templateId by remember(binding.templateId) { mutableStateOf(binding.templateId) }
    var audience by remember(binding) { mutableStateOf(binding.audience) }
    var triggerKey by remember(binding) { mutableStateOf(binding.triggerKey ?: "") }
    var active by remember(binding) { mutableStateOf(binding.active) }
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    AuntieDialog(
        visible = true,
        // "New Binding" when catalogKey is blank, else "Edit: {catalogKey}".
        title = if (isNew) "New Binding" else "Edit: ${binding.catalogKey}",
        onDismiss = onDismiss,
        maxWidth = 560.dp,
        closeIcon = Lucide.X,
        leadingIcon = {
            AuntieIconTile(icon = Lucide.Workflow, tone = AuntieStatusTone.Purple, size = 38.dp)
        },
        // Backend reality: catalog key (+ optional audience / trigger override) maps
        // onto a Firestore email template; the dispatcher resolves per trigger.
        hint = "Catalog key + optional audience / trigger override binds to a Firestore email template. The dispatcher resolves the right template per notification trigger.",
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
            PrimaryButton(
                label = "Save",
                // Save enabled only when catalogKey AND templateId are both non-blank.
                enabled = catalogKey.isNotBlank() && templateId.isNotBlank(),
                onClick = {
                    onSave(
                        binding.copy(
                            // On edit the catalogKey is locked, so this always equals
                            // the original doc ID (no orphan-rename path).
                            catalogKey = catalogKey,
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
        if (isNew) {
            BottomBorderField(
                value = catalogKey,
                onValueChange = { catalogKey = it },
                label = "Catalog Key",
                placeholder = "e.g. kincare.booking.confirm",
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            // catalogKey is the immutable doc ID on an existing binding. Editing it
            // here would create a second orphaned doc (no delete callable to clean up),
            // so it is shown read-only with a note instead of an editable field.
            AuntieFieldLabel(text = "Catalog Key")
            Text(
                binding.catalogKey,
                style = AuntieTheme.typography.mono.copy(fontSize = 14.sp),
                color = c.textPrimary,
                modifier = Modifier.padding(top = dims.space1, bottom = dims.space1),
            )
            Text(
                "Catalog key is the binding's identity and cannot be changed. To rebind a different key, add a new binding.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }

        // Template selector: one selectable row per EmailTemplate (title + optional
        // category). Selected row washes the brand accent and warms its border. If no
        // templates loaded, the picker would be empty, so fail loud instead.
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Template")
            if (templates.isEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "No templates to choose from",
                ) {
                    Text(
                        "No email templates loaded, so this binding cannot be saved. Add a template in the Template Bank first.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space1)) {
                    templates.forEach { tpl ->
                        AuntieChip(
                            label = tpl.title,
                            secondaryLabel = tpl.category,
                            selected = tpl.templateId == templateId,
                            onClick = { templateId = tpl.templateId },
                            tone = AuntieChipTone.Orange,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }

        // Audience pills: single-select; clicking the selected one clears it (nullable).
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Audience")
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                AUDIENCES.forEach { a ->
                    val isSelected = a == audience
                    AuntieChip(
                        label = a,
                        selected = isSelected,
                        onClick = { audience = if (isSelected) null else a },
                        tone = AuntieChipTone.Orange,
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

        // active toggle + "Active" / "Paused" label.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            AuntieToggle(checked = active, onCheckedChange = { active = it })
            Text(
                if (active) "Active" else "Paused",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
    }
}
