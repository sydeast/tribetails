package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.KinTaleTemplateRemoval
import com.tribetails.auntieos.data.model.KinTaleTemplateUsage
import com.tribetails.auntieos.data.model.kinTaleTemplateArchiveImpact
import com.tribetails.auntieos.data.model.kinTaleTemplateDeleteHeadline
import com.tribetails.auntieos.data.model.kinTaleTemplateRemovalImpact
import com.tribetails.auntieos.data.model.kinTaleTemplateRestoreClearsDefault
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class KinTaleTemplatesUiState(
    val isLoading: Boolean = true,
    val templates: List<KinTaleTemplate> = emptyList(),
    val error: String? = null,
    // #1591: archive / restore / delete-for-good.
    val busy: Boolean = false,
    val notice: String? = null,
    val actionError: String? = null,
    /** The usage count for the open delete-for-good confirm. */
    val deleteUsage: KinTaleTemplateUsage? = null,
    val deleteUsageError: String? = null,
) {
    /** #1591: the list. An archived template is not in it. */
    val liveTemplates: List<KinTaleTemplate> get() = templates.filterNot { it.archived }
    /** #1591: the Archive panel. */
    val archivedTemplates: List<KinTaleTemplate> get() = templates.filter { it.archived }
}

class KinTaleTemplatesViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(KinTaleTemplatesUiState())
    val uiState: StateFlow<KinTaleTemplatesUiState> = _uiState.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getKinTaleTemplates().fold(
                onSuccess = { list ->
                    // A copy, so a notice from the archive action that triggered this reload survives it.
                    _uiState.value = _uiState.value.copy(isLoading = false, templates = list, error = null)
                },
                onFailure = { e ->
                    _uiState.value = KinTaleTemplatesUiState(isLoading = false, error = e.message)
                }
            )
        }
    }

    private fun label(t: KinTaleTemplate) = t.name.ifBlank { "Untitled template" }

    private fun run(mode: KinTaleTemplateRemoval, t: KinTaleTemplate, clearDefault: Boolean, done: String) {
        if (_uiState.value.busy) return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(busy = true, actionError = null, notice = null)
            repository.removeKinTaleTemplate(t.id, mode, clearDefault).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(busy = false, notice = done, deleteUsage = null)
                    load()
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(busy = false, actionError = e.message ?: "Failed")
                },
            )
        }
    }

    /** #1591: Remove = move to the archive. */
    fun archive(t: KinTaleTemplate) = run(KinTaleTemplateRemoval.ARCHIVE, t, false, "${label(t)} moved to the archive.")

    /** #1591: back into the list, dropping the default flag if another template took it. */
    fun restore(t: KinTaleTemplate) = run(
        KinTaleTemplateRemoval.RESTORE,
        t,
        kinTaleTemplateRestoreClearsDefault(t, _uiState.value.templates),
        "${label(t)} is back in the template list.",
    )

    /** #1591: reads the usage count the delete-for-good confirm leads with. */
    fun loadDeleteUsage(t: KinTaleTemplate) {
        _uiState.value = _uiState.value.copy(deleteUsage = null, deleteUsageError = null, actionError = null)
        viewModelScope.launch {
            repository.getKinTaleTemplateUsage(t.id).fold(
                onSuccess = { _uiState.value = _uiState.value.copy(deleteUsage = it) },
                onFailure = { e -> _uiState.value = _uiState.value.copy(deleteUsageError = e.message ?: "Failed") },
            )
        }
    }

    /** #1591: delete for good, from the archive only, and only once the count has been read. */
    fun deleteForGood(t: KinTaleTemplate) {
        if (!t.archived || _uiState.value.deleteUsage == null) return
        run(KinTaleTemplateRemoval.DELETE, t, false, "${label(t)} deleted for good.")
    }
}

/**
 * The KinTale template picker, laid out as the template-editor mock's
 * "Templates" section (`ui-ideas/auntieos-kintale-template-editor-2026-05-27.html`):
 * the kit band with the mock's kicker, one panel of rows, each the template's
 * name with the Default / Inactive capsule beside it, and "New template" as the
 * band's control. The built-in default is not a row: it is what a new template
 * starts from when nothing is saved yet, and the empty state says so, matching
 * the web picker word for word.
 */
@Composable
fun KinTaleTemplatesScreen(
    onBack: () -> Unit,
    onCreateTemplate: () -> Unit = {},
    onEditTemplate: (templateId: String) -> Unit = {},
    viewModel: KinTaleTemplatesViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsState()
    var removing by remember { mutableStateOf<KinTaleTemplate?>(null) }
    var deleting by remember { mutableStateOf<KinTaleTemplate?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    AuntieScreenScaffold(title = "KinTale templates", onBack = onBack) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            DenScreenHeading(
                kicker = "The Den · KinTale templates",
                title = "KinTale templates",
                subtitle = "Shape the recap that goes home: which sections show, and the checklist Auntie fills out each visit.",
                trailing = {
                    GhostButton(
                        label = "New template",
                        onClick = onCreateTemplate,
                        leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(14.dp)) },
                    )
                },
            )

            DenPanel(title = "Templates", subtitle = "Pick one to edit, or start a new one.") {
                when {
                    state.isLoading -> LoadingHint("Loading templates...")
                    state.error != null -> EmptyHint("Couldn't load templates: ${state.error}", error = true)
                    state.liveTemplates.isEmpty() -> EmptyHint(
                        "No templates saved yet. New template starts from the built-in default, ready to save as your first.",
                    )
                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.liveTemplates.forEach { tpl ->
                            TemplateRow(
                                template = tpl,
                                onClick = { onEditTemplate(tpl.id) },
                                onRemove = { removing = tpl },
                            )
                        }
                    }
                }
            }

            state.notice?.let { Text(it, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.success) }
            state.actionError?.let { Text(it, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.error) }

            // #1591: removed templates, restorable, and the only place one is deleted for good.
            if (state.archivedTemplates.isNotEmpty()) {
                DenPanel(title = "Archive", meta = "${state.archivedTemplates.size}") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.archivedTemplates.forEach { tpl ->
                            ArchivedRow(
                                template = tpl,
                                busy = state.busy,
                                onRestore = { viewModel.restore(tpl) },
                                onDelete = {
                                    deleting = tpl
                                    viewModel.loadDeleteUsage(tpl)
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    removing?.let { tpl ->
        AuntieDialog(
            visible = true,
            title = "Remove ${tpl.name.ifBlank { "Untitled template" }}?",
            onDismiss = { removing = null },
            footer = {
                GhostButton(label = "Cancel", onClick = { removing = null })
                PrimaryButton(
                    label = "Move to archive",
                    onClick = {
                        removing = null
                        viewModel.archive(tpl)
                    },
                )
            },
        ) {
            kinTaleTemplateArchiveImpact(tpl.isDefault).forEach { line ->
                Text(line, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
            }
        }
    }
    deleting?.let { tpl ->
        AuntieDialog(
            visible = true,
            title = "Delete ${tpl.name.ifBlank { "Untitled template" }} for good?",
            onDismiss = { deleting = null },
            footer = {
                GhostButton(label = "Cancel", onClick = { deleting = null })
                PrimaryButton(
                    label = "Delete for good",
                    // Off until the count has loaded: nobody deletes past a warning they never saw.
                    enabled = state.deleteUsage != null && !state.busy,
                    onClick = {
                        deleting = null
                        viewModel.deleteForGood(tpl)
                    },
                )
            },
        ) {
            val usage = state.deleteUsage
            when {
                state.deleteUsageError != null -> Text(
                    "Couldn't count the KinTales that used it: ${state.deleteUsageError}",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.error,
                )
                usage == null -> LoadingHint("Counting the KinTales that used it...")
                else -> {
                    Text(kinTaleTemplateDeleteHeadline(usage), style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
                    kinTaleTemplateRemovalImpact(usage).forEach { line ->
                        Text(line, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                    }
                    Text("This cannot be undone.", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
                }
            }
        }
    }
}

/** #1591: an archived template's row: its name, Restore and Delete for good. */
@Composable
private fun ArchivedRow(template: KinTaleTemplate, busy: Boolean, onRestore: () -> Unit, onDelete: () -> Unit) {
    val c = AuntieTheme.colors
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(AuntieTheme.dims.borderHairline, c.border, shape)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = template.name.ifBlank { "Untitled template" },
            style = AuntieTheme.typography.titleMedium,
            color = c.textDim,
            modifier = Modifier.weight(1f),
        )
        GhostButton(label = "Restore", onClick = onRestore, enabled = !busy)
        GhostButton(label = "Delete for good", onClick = onDelete, enabled = !busy)
    }
}

/**
 * The mock's `.tpl` row: the name, then the capsule. A row on the glass
 * surface at a hairline, the same card the logs screen's rows sit on.
 */
@Composable
private fun TemplateRow(template: KinTaleTemplate, onClick: () -> Unit, onRemove: () -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surfaceGlass)
            .border(dims.borderHairline, c.border, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                text = template.name.ifBlank { "Untitled template" },
                style = AuntieTheme.typography.titleMedium,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            if (template.isDefault) {
                AuntieStatusPill(label = "Default", tone = AuntieStatusTone.Orange, compact = true)
            }
            if (!template.isActive) {
                AuntieStatusPill(label = "Inactive", tone = AuntieStatusTone.Muted, compact = true)
            }
            // #1591: Remove moves it to the archive, after a confirm.
            GhostButton(label = "Remove", onClick = onRemove)
        }
        if (template.description.isNotBlank()) {
            Text(template.description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}
