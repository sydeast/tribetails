package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
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

@Composable
fun KinTaleTemplatesScreen(
    onBack: () -> Unit,
    onCreateTemplate: () -> Unit = {},
    onEditTemplate: (templateId: String) -> Unit = {},
    viewModel: KinTaleTemplatesViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }

    AuntieScreenScaffold(title = "KinTale Templates", onBack = onBack) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(16.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.12f))
                        .padding(14.dp)
                ) {
                    Text("Built-in default", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                    Spacer(Modifier.height(4.dp))
                    Text(DefaultKinTaleTemplate.template.name, style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(DefaultKinTaleTemplate.template.description, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Used when no service-specific template is configured. Tap 'New Template' to create your own.",
                        style = AuntieTheme.typography.bodySmall
                    )
                }

                Spacer(Modifier.height(20.dp))

                Text("Custom templates", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))

                when {
                    state.isLoading -> AuntieSpinner(modifier = Modifier.size(32.dp), color = AuntieTheme.colors.kinfolkOrange)
                    state.error != null -> Text("Couldn't load templates: ${state.error}", color = AuntieTheme.colors.error, style = AuntieTheme.typography.bodySmall)
                    state.templates.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(AuntieTheme.colors.surface)
                                .padding(20.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "No custom templates yet. The default above is active.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim
                            )
                        }
                    }
                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.templates, key = { it.id }) { tpl ->
                            TemplateRow(template = tpl, onClick = { onEditTemplate(tpl.id) })
                        }
                    }
                }
            }

            // Extended FAB overlay
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(AuntieTheme.colors.kinfolkOrange)
                    .clickable(onClick = onCreateTemplate)
                    .padding(horizontal = 20.dp, vertical = 14.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Lucide.Plus, contentDescription = null, tint = AuntieTheme.colors.background)
                    Spacer(Modifier.width(6.dp))
                    Text("New Template", fontWeight = FontWeight.SemiBold, color = AuntieTheme.colors.background, style = AuntieTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun TemplateRow(template: KinTaleTemplate, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .clickable(onClick = onClick)
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(template.name, style = AuntieTheme.typography.titleMedium, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            if (template.isDefault) {
                StatusBadge("Default", AuntieTheme.colors.kinfolkOrange)
            } else if (!template.isActive) {
                StatusBadge("Inactive", AuntieTheme.colors.textDim)
            }
        }
        if (template.description.isNotBlank()) {
            Text(template.description, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        if (template.serviceTypeKeys.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Services: " + template.serviceTypeKeys.joinToString(", "),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )
        }
        Spacer(Modifier.height(4.dp))
        val enabledSections = listOf(
            template.photoShowcaseEnabled,
            template.checklistEnabled,
            template.petMoodEnabled,
            template.visitNotesEnabled,
            template.nextAppointmentEnabled,
            template.reviewBoosterEnabled
        ).count { it }
        Text(
            "$enabledSections section(s) on • ${template.checklistItems.size} checklist item(s) • ${template.moodOptions.size} mood(s)",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim
        )
    }
}

@Composable
private fun StatusBadge(label: String, color: androidx.compose.ui.graphics.Color) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(label, style = AuntieTheme.typography.labelSmall, color = color)
    }
}
