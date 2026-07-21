package com.tribetails.auntieos.ui.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.data.model.ReviewBoosterConfig
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AO-22: the ReviewBooster "Configure" action was a dead lambda
 * (Navigation.kt: onConfigureReviewBooster = { /* Phase 2E: editor TBD */ }),
 * so tapping it did nothing while the other two template sub-editors (Checklist,
 * Moods) navigated to real screens. The reviewBoosterConfig model and the
 * KinTaleTemplateEditorViewModel.updateReviewBoosterConfig writer already
 * existed; this is the missing editor UI. Web has only the on/off toggle and is
 * throwaway (A8), so this is android-only — the React port builds its own.
 *
 * Per-platform: which review sites the booster links to, and the URL for each.
 * Persisted on focus loss / toggle change, same pattern as the mood editor.
 */
@Composable
fun ReviewBoosterEditorScreen(
    templateId: String?,
    onBack: () -> Unit,
    viewModel: KinTaleTemplateEditorViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    LaunchedEffect(templateId) { viewModel.load(templateId) }

    val config = state.template.reviewBoosterConfig

    fun update(mutate: ReviewBoosterConfig.() -> ReviewBoosterConfig) {
        viewModel.updateReviewBoosterConfig(config.mutate())
    }

    AuntieScreenScaffold(
        title = "Configure Review Booster",
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
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        "When a kinfolk marks a KinTale as loved, the booster invites them to " +
                            "leave a review on the sites you enable below.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )

                    PlatformRow(
                        label = "Google",
                        enabled = config.googleEnabled,
                        url = config.googleUrl,
                        onEnabledChange = { on -> update { copy(googleEnabled = on) }; viewModel.persist() },
                        onUrlChange = { url -> update { copy(googleUrl = url) } },
                        onPersist = viewModel::persist,
                    )
                    PlatformRow(
                        label = "Yelp",
                        enabled = config.yelpEnabled,
                        url = config.yelpUrl,
                        onEnabledChange = { on -> update { copy(yelpEnabled = on) }; viewModel.persist() },
                        onUrlChange = { url -> update { copy(yelpUrl = url) } },
                        onPersist = viewModel::persist,
                    )
                    PlatformRow(
                        label = "Facebook",
                        enabled = config.facebookEnabled,
                        url = config.facebookUrl,
                        onEnabledChange = { on -> update { copy(facebookEnabled = on) }; viewModel.persist() },
                        onUrlChange = { url -> update { copy(facebookUrl = url) } },
                        onPersist = viewModel::persist,
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.background)
                .padding(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                GhostButton(label = "Cancel", onClick = onBack, modifier = Modifier.weight(1f))
                PrimaryButton(
                    label = "Save Changes",
                    onClick = {
                        viewModel.persist()
                        onBack()
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun PlatformRow(
    label: String,
    enabled: Boolean,
    url: String,
    onEnabledChange: (Boolean) -> Unit,
    onUrlChange: (String) -> Unit,
    onPersist: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                style = AuntieTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            AuntieToggle(checked = enabled, onCheckedChange = onEnabledChange)
        }
        if (enabled) {
            AuntieField(
                value = url,
                onValueChange = onUrlChange,
                placeholder = "https://…",
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { if (!it.isFocused) onPersist() },
            )
        }
    }
}
