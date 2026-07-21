package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import com.tribetails.auntieos.data.repository.unboundCatalogKeys
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
 * Template Assignment in the Den aesthetic. Ported from the web Den layout
 * (web/.../screens/admin/TemplateAssignmentScreen.kt) while keeping the Android
 * [TemplateRepository] contract intact: bindings and templates load through
 * [TemplateRepository.listBindings] / [listTemplates], and the only mutation is
 * [TemplateRepository.assignTemplate].
 *
 * Fail-loud honesty (per project policy), mirroring the web spec:
 *  - The per-card "override: {triggerKey}" echo is always on, but only renders for
 *    a GENUINE override (triggerKey present AND different from catalogKey), because
 *    the server defaults a blank triggerKey to the catalogKey and an unguarded echo
 *    would fire on every binding.
 *  - The "unbound catalog keys" hint panel is wired for real (Stage 2 tail): it
 *    reads the dispatcher catalog via listCatalogKeys and diffs it against the bound
 *    catalog keys to surface keys that have no binding. Always on.
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

/**
 * Standalone Template Assignment screen. Kept for direct use; the merged two-tab
 * [TemplatesScreen] renders [TemplateAssignmentBody] inside its shared scaffold.
 */
@Composable
fun TemplateAssignmentScreen(
    onBack: () -> Unit,
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    AuntieScreenScaffold(title = "Template Assignment", onBack = onBack) {
        TemplateAssignmentBody(templateRepo)
    }
}

/** Template Assignment content without the outer scaffold (see [TemplateAssignmentScreen]). */
@Composable
fun TemplateAssignmentBody(
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberCoroutineScope()
    var bindings by remember { mutableStateOf<List<TemplateRepository.TemplateBinding>>(emptyList()) }
    var templates by remember { mutableStateOf<List<TemplateRepository.EmailTemplate>>(emptyList()) }
    // Stage 2 tail: dispatcher catalog keys (listCatalogKeys) + the diff-derived
    // unbound set (keys with no binding). A separate read-error channel so a catalog
    // failure surfaces loudly without masking the bindings/templates state.
    var catalogKeys by remember { mutableStateOf<List<String>>(emptyList()) }
    var catalogError by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    // Two distinct read-error channels so a bindings failure and a templates failure
    // are never conflated: a listTemplates error must not coexist silently with a
    // populated bindings list, and a recovered call drops its own stale banner.
    var bindingsError by remember { mutableStateOf<String?>(null) }
    var templatesError by remember { mutableStateOf<String?>(null) }
    // Write-path error from assignTemplate, surfaced loudly and dismissable.
    var saveError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<TemplateRepository.TemplateBinding?>(null) }
    // SUGGESTION: client-side search over the loaded binding list. Pure in-memory
    // filter; touches no callable or data wiring.
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
            .onSuccess { catalogKeys = it }
            .onFailure { catalogError = it.message ?: "Could not load catalog keys." }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    val activeCount = bindings.count { it.active }
    val pausedCount = bindings.size - activeCount
    val templatesMissing = !loading && templatesError == null && templates.isEmpty()
    val canAdd = templates.isNotEmpty()

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space4),
            modifier = Modifier.fillMaxSize(),
        ) {
            item {
                DenScreenHeading(
                    kicker = "The Den · Admin",
                    title = "Template",
                    accentTail = "Assignment.",
                    subtitle = "Bind email templates to notification triggers.",
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
                        Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
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
                            "$msg The template picker and Add Binding stay disabled until templates load.",
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
                            "Add Binding is disabled until at least one email template exists in the Template Bank.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }

            // Catalog-keys read error surfaces loudly, separate from bindings/templates.
            catalogError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Could not load catalog keys",
                        icon = Lucide.Workflow,
                        onDismiss = { catalogError = null },
                    ) {
                        Text(
                            "$msg The unbound-catalog hint is unavailable until this loads.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                }
            }

            // Unbound catalog keys (Stage 2 tail): dispatcher catalog keys with no
            // binding doc. listCatalogKeys gives the catalog; we diff against the bound
            // keys. Shown only when there is at least one unbound key, and only after a
            // successful catalog read (a failure surfaces the error banner above instead).
            if (catalogError == null && catalogKeys.isNotEmpty()) {
                val unbound = unboundCatalogKeys(catalogKeys, bindings.map { it.catalogKey })
                if (unbound.isNotEmpty()) {
                    item {
                        UnboundCatalogPanel(unbound = unbound)
                    }
                }
            }

            item {
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
                        bindings.isEmpty() -> EmptyHint(
                            "No bindings yet. Defaults from the catalog apply until you assign one.",
                        )
                        else -> {
                            // SUGGESTION: client-side search field over the loaded bindings.
                            // Pure in-memory filter; touches no callable.
                            AuntieSearchField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = "Search by catalog key or template...",
                                onClear = { query = "" },
                                modifier = Modifier.fillMaxWidth(),
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
                                    verticalArrangement = Arrangement.spacedBy(dims.space2),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    visible.forEach { binding ->
                                        BindingRow(binding = binding, onEdit = { selected = binding })
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(dims.space4))
                    // Add Binding is gated on having at least one template to assign. With
                    // an empty templates list the editor's picker is unselectable and Save
                    // can never enable, so the button stays disabled (see banner above).
                    PrimaryButton(
                        label = "Add Binding",
                        enabled = canAdd && !loading,
                        onClick = {
                            selected = TemplateRepository.TemplateBinding(
                                catalogKey = "",
                                templateId = templates.firstOrNull()?.templateId ?: "",
                                audience = null,
                                triggerKey = null,
                                active = true,
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

    selected?.let { current ->
        BindingEditorDialog(
            binding = current,
            templates = templates,
            // catalogKey is the Firestore doc ID. On an existing binding it is
            // immutable here: editing it would orphan the old doc and create a new
            // one. The field is locked on edit; removing the binding entirely goes
            // through Unassign (AO-56), not a catalogKey rename.
            isNew = current.catalogKey.isBlank(),
            onDismiss = { selected = null },
            // AO-56: unassign an existing binding via the unassignTemplate callable.
            // Null for a brand-new (unsaved) binding, so the button only shows on edit.
            onUnassign = if (current.catalogKey.isBlank()) null else {
                {
                    scope.launch {
                        templateRepo.unassignTemplate(current.catalogKey)
                            .onSuccess {
                                selected = null
                                saveError = null
                                reload()
                            }
                            .onFailure { saveError = it.message ?: "Unassign failed." }
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
 * Unbound catalog keys panel (Stage 2 tail): dispatcher catalog keys that have no
 * binding doc, surfaced as mono chips so the operator can spot keys falling through
 * to the catalog default. Read-only hint; tapping a key is not wired (Add Binding is
 * the authoring path). The count is the real diff size.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UnboundCatalogPanel(unbound: List<String>) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Unbound catalog keys",
        subtitle = "Catalog keys with no binding yet. They fall through to the catalog default until you assign one.",
        trailing = {
            AuntieStatusPill(
                label = "${unbound.size} unbound",
                tone = AuntieStatusTone.Warning,
                showDot = true,
            )
        },
    ) {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(dims.space2),
            verticalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            unbound.forEach { key ->
                Text(
                    text = key,
                    style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
                    color = c.textPrimary,
                    modifier = Modifier
                        .padding(end = dims.space1)
                        .then(Modifier),
                )
            }
        }
    }
}

/**
 * One binding as a Den entity row: a Workflow icon tile leads, the dotted
 * catalogKey is the title, the "→ {templateId}" arrow line plus optional audience
 * sit in the subtitle, and an ACTIVE / PAUSED status pill with an Edit ghost
 * button trail. The arrow is a plain right arrow, not an em dash.
 */
@Composable
private fun BindingRow(
    binding: TemplateRepository.TemplateBinding,
    onEdit: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // triggerKey override echo (always on): only renders for a GENUINE override
    // (triggerKey present AND different from catalogKey). The server defaults a blank
    // triggerKey to the catalogKey, so this guard stops it firing on every binding.
    val genuineOverride = genuineTriggerOverride(binding.triggerKey, binding.catalogKey)

    val subtitle = buildString {
        append("→ ${binding.templateId}")
        binding.audience?.let { append("\nAudience: $it") }
        genuineOverride?.let { append("\noverride: $it") }
    }

    AuntieEntityRow(
        title = binding.catalogKey,
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
                    label = if (binding.active) "ACTIVE" else "PAUSED",
                    tone = if (binding.active) AuntieStatusTone.Success else AuntieStatusTone.Muted,
                    mono = true,
                )
                GhostButton(label = "Edit", onClick = onEdit)
            }
        },
        showDivider = true,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BindingEditorDialog(
    binding: TemplateRepository.TemplateBinding,
    templates: List<TemplateRepository.EmailTemplate>,
    isNew: Boolean,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.TemplateBinding) -> Unit,
    // AO-56: edit-mode only. Null on a new binding (nothing to unassign yet).
    onUnassign: (() -> Unit)? = null,
) {
    var catalogKey by remember(binding.catalogKey) { mutableStateOf(binding.catalogKey) }
    var templateId by remember(binding.templateId) { mutableStateOf(binding.templateId) }
    var audience by remember(binding) { mutableStateOf(binding.audience) }
    var triggerKey by remember(binding) { mutableStateOf(binding.triggerKey ?: "") }
    var active by remember(binding) { mutableStateOf(binding.active) }
    // Two-tap confirm for the destructive unassign, rather than a second nested
    // dialog (two AuntieDialogs would fight over dismiss/back).
    var confirmingUnassign by remember(binding) { mutableStateOf(false) }
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
            if (onUnassign != null) {
                GhostButton(
                    // First tap arms, second tap unassigns: a lightweight confirm on a
                    // change that alters what dispatch sends.
                    label = if (confirmingUnassign) "Confirm unassign" else "Unassign",
                    onClick = {
                        if (confirmingUnassign) onUnassign() else confirmingUnassign = true
                    },
                    modifier = Modifier.weight(1f),
                )
            }
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
            // here would create a second orphaned doc (no delete callable to clean
            // up), so it is shown read-only with a note instead of an editable field.
            AuntieFieldLabel(text = "Catalog Key")
            Text(
                binding.catalogKey,
                style = AuntieTheme.typography.mono.copy(fontSize = 14.sp),
                color = c.textPrimary,
                modifier = Modifier.padding(top = dims.space1, bottom = dims.space1),
            )
            AuntieNoteCallout(
                text = "Catalog key is the binding's identity and cannot be changed. To rebind a different key, add a new binding.",
            )
        }

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
                        "No email templates loaded, so this binding cannot be saved. Add a template in the Template Bank first.",
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
            AuntieFieldLabel(text = "Audience")
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
