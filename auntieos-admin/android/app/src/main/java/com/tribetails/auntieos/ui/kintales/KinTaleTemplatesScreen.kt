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
    val error: String? = null
)

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
                    _uiState.value = KinTaleTemplatesUiState(isLoading = false, templates = list)
                },
                onFailure = { e ->
                    _uiState.value = KinTaleTemplatesUiState(isLoading = false, error = e.message)
                }
            )
        }
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
                    state.templates.isEmpty() -> EmptyHint(
                        "No templates saved yet. New template starts from the built-in default, ready to save as your first.",
                    )
                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.templates.forEach { tpl ->
                            TemplateRow(template = tpl, onClick = { onEditTemplate(tpl.id) })
                        }
                    }
                }
            }
        }
    }
}

/**
 * The mock's `.tpl` row: the name, then the capsule. A row on the glass
 * surface at a hairline, the same card the logs screen's rows sit on.
 */
@Composable
private fun TemplateRow(template: KinTaleTemplate, onClick: () -> Unit) {
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
        }
        if (template.description.isNotBlank()) {
            Text(template.description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}
