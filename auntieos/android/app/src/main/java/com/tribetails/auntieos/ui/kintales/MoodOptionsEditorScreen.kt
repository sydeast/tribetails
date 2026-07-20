package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.data.model.MoodOption
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun MoodOptionsEditorScreen(
    templateId: String?,
    onBack: () -> Unit,
    viewModel: KinTaleTemplateEditorViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsState()
    LaunchedEffect(templateId) { viewModel.load(templateId) }

    val moods = state.template.moodOptions.sortedBy { it.order }

    AuntieScreenScaffold(
        title = "Configure Mood Options",
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
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Mood Options (${moods.size})",
                            style = AuntieTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f)
                        )
                        PrimaryButton(
                            label = "Add Mood",
                            onClick = { viewModel.addMoodOption() },
                            leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(18.dp)) }
                        )
                    }

                    if (moods.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(AuntieTheme.colors.surface)
                                .padding(20.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "No mood options yet. Add one to get started.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim
                            )
                        }
                    } else {
                        moods.forEach { mood ->
                            MoodOptionEditor(
                                mood = mood,
                                onUpdate = viewModel::updateMoodOption,
                                onDelete = { viewModel.removeMoodOption(it); viewModel.persist() },
                                onPersist = viewModel::persist
                            )
                        }
                    }
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.background)
                .padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                GhostButton(
                    label = "Cancel",
                    onClick = onBack,
                    modifier = Modifier.weight(1f)
                )
                PrimaryButton(
                    label = "Save Changes",
                    onClick = {
                        viewModel.persist()
                        onBack()
                    },
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun MoodOptionEditor(
    mood: MoodOption,
    onUpdate: (MoodOption) -> Unit,
    onDelete: (key: String) -> Unit,
    onPersist: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AuntieField(
            value = mood.emoji,
            onValueChange = { onUpdate(mood.copy(emoji = it.take(2))) },
            placeholder = "😊",
            modifier = Modifier
                .width(80.dp)
                .onFocusChanged { if (!it.isFocused) onPersist() },
        )
        Spacer(Modifier.width(10.dp))
        AuntieField(
            value = mood.label,
            onValueChange = { onUpdate(mood.copy(label = it)) },
            placeholder = "Mood label",
            modifier = Modifier
                .weight(1f)
                .onFocusChanged { if (!it.isFocused) onPersist() },
        )
        AuntieIconBtn(onClick = { onDelete(mood.key) }) {
            Icon(Lucide.Trash2, contentDescription = "Delete", tint = AuntieTheme.colors.error)
        }
    }
}
