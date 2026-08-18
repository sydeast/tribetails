package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import com.tribetails.auntieos.ui.components.AuntieToggle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun KinTaleTemplateEditorScreen(
    templateId: String?,
    onBack: () -> Unit,
    onConfigureChecklist: () -> Unit,
    onConfigureMoods: () -> Unit,
    onConfigureReviewBooster: () -> Unit,
    viewModel: KinTaleTemplateEditorViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(templateId) { viewModel.load(templateId) }

    AuntieScreenScaffold(
        title = state.template.name.ifBlank { "New Template" },
        onBack = {
            viewModel.persist()
            onBack()
        },
        actions = { SaveStatusBadge(state.saveStatus, state.isSaving) },
        imePaddingEnabled = true,
    ) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (state.isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AuntieSpinner(modifier = Modifier.size(32.dp), color = AuntieTheme.colors.kinfolkOrange)
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)
                ) {
                    BasicSettingsSection(state, viewModel)
                    DisplaySectionsHeader()
                    DisplaySectionToggleCard(
                        title = "Photo Showcase",
                        description = "When enabled, you can add photos to the report card with optional descriptions for each photo.",
                        enabled = state.template.photoShowcaseEnabled,
                        onToggle = { viewModel.togglePhotoShowcase(it); viewModel.persist() }
                    )
                    DisplaySectionToggleCard(
                        title = "Checklist",
                        description = "Configure checklist items that can be marked as completed during visits. Items can be per-pet or per-visit.",
                        enabled = state.template.checklistEnabled,
                        actionLabel = "Configure Checklist Items (${state.template.checklistItems.size})",
                        onToggle = { viewModel.toggleChecklist(it); viewModel.persist() },
                        onAction = onConfigureChecklist
                    )
                    DisplaySectionToggleCard(
                        title = "Pet Mood",
                        description = "Configure mood options that can be selected for each pet during visits.",
                        enabled = state.template.petMoodEnabled,
                        actionLabel = "Configure Mood Options (${state.template.moodOptions.size})",
                        onToggle = { viewModel.togglePetMood(it); viewModel.persist() },
                        onAction = onConfigureMoods
                    )
                    DisplaySectionToggleCard(
                        title = "Visit Notes",
                        description = "When enabled, you can add detailed notes about the visit using a rich text editor.",
                        enabled = state.template.visitNotesEnabled,
                        onToggle = { viewModel.toggleVisitNotes(it); viewModel.persist() }
                    )
                    DisplaySectionToggleCard(
                        title = "Next Appointment",
                        description = "Displays the client's next scheduled appointment and provides a 'Book Now' button to nudge them to book their next appointment.",
                        enabled = state.template.nextAppointmentEnabled,
                        onToggle = { viewModel.toggleNextAppointment(it); viewModel.persist() }
                    )
                    DisplaySectionToggleCard(
                        title = "Review Booster",
                        description = "Embeds a review request section in the report card to encourage clients to leave reviews.",
                        enabled = state.template.reviewBoosterEnabled,
                        actionLabel = "Configure Review Booster Settings",
                        onToggle = { viewModel.toggleReviewBooster(it); viewModel.persist() },
                        onAction = onConfigureReviewBooster
                    )
                }
            }
        }

        // Auto-save status bar
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.background)
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            val (label, color) = when {
                state.isSaving -> "Saving..." to AuntieTheme.colors.kinfolkOrange
                state.saveStatus == SaveStatus.SAVED -> "✓ All Changes Saved" to AuntieTheme.colors.success
                state.saveStatus == SaveStatus.ERROR -> "Save failed" to AuntieTheme.colors.error
                else -> "Auto-saves on field blur" to AuntieTheme.colors.textDim
            }
            Text(label, color = color, style = AuntieTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun BasicSettingsSection(
    state: TemplateEditorUiState,
    viewModel: KinTaleTemplateEditorViewModel
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Basic Settings", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

        LabeledField(label = "Template Name", helper = "Used for internal organization only.") {
            AuntieField(
                value = state.template.name,
                onValueChange = viewModel::updateName,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { if (!it.isFocused) viewModel.persist() },
            )
        }

        LabeledField(label = "Description", helper = "Used for internal organization only.") {
            AuntieField(
                value = state.template.description,
                onValueChange = viewModel::updateDescription,
                singleLine = false,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { if (!it.isFocused) viewModel.persist() }
            )
        }

        LabeledField(label = "Default Email Message", helper = "No default on purpose: the message is the story of the visit, and Auntie writes it fresh each time.") {
            AuntieField(
                value = state.template.defaultEmailMessage,
                onValueChange = viewModel::updateDefaultEmailMessage,
                placeholder = "The note that opens the recap.",
                singleLine = false,
                minLines = 2,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 80.dp)
                    .onFocusChanged { if (!it.isFocused) viewModel.persist() },
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface2.copy(alpha = 0.3f))
                .padding(12.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Make Default Template", style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Text(
                        "Default templates are automatically selected for services that are not assigned to another template.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim
                    )
                }
                AuntieToggle(
                    checked = state.template.isDefault,
                    onCheckedChange = {
                        viewModel.toggleIsDefault(it)
                        viewModel.persist()
                    },
                    enabled = !state.isOnlyDefault || !state.template.isDefault,
                )
            }
            if (state.isOnlyDefault && state.template.isDefault) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Lucide.TriangleAlert, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "This is the only default template and cannot be disabled unless another template is set as default first.",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.kinfolkOrange
                    )
                }
            }
        }
    }
}

@Composable
private fun DisplaySectionsHeader() {
    Text(
        "Display Sections",
        style = AuntieTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold
    )
}

@Composable
private fun DisplaySectionToggleCard(
    title: String,
    description: String,
    enabled: Boolean,
    actionLabel: String? = null,
    onToggle: (Boolean) -> Unit,
    onAction: (() -> Unit)? = null
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            AuntieToggle(checked = enabled, onCheckedChange = onToggle)
        }
        Spacer(Modifier.height(6.dp))
        Text(description, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        if (actionLabel != null && onAction != null && enabled) {
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onAction)
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(actionLabel, color = AuntieTheme.colors.kinfolkOrange, style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Icon(Lucide.ChevronRight, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
            }
        }
    }
}

@Composable
private fun LabeledField(label: String, helper: String?, content: @Composable () -> Unit) {
    Column {
        Text(label, style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(4.dp))
        content()
        if (!helper.isNullOrBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(helper, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        }
    }
}
