package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
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

/**
 * The KinTale template editor, laid out as its mock
 * (`ui-ideas/auntieos-kintale-template-editor-2026-05-27.html`): the kit band
 * with the trail "KinTales / Templates / <name>" and "Editing <name>" as the
 * title, then the "Basic settings" panel (the three fields and the two
 * toggle rows) and the "Display sections" panel (one toggle row per section).
 *
 * The checklist, mood and review-booster editors stay their own screens,
 * reached from the row of the section they belong to: folding 700 lines of
 * checklist editing inline is not a skin change and is not attempted here.
 *
 * Wiring is preserved verbatim: every field persists on blur and every toggle
 * persists on change through [KinTaleTemplateEditorViewModel], and the save
 * status badge stays in the scaffold bar where it is visible while scrolling.
 */
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

    val name = state.template.name.ifBlank { "New template" }
    val isNew = templateId == null

    AuntieScreenScaffold(
        title = name,
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
                    // The mock's head: the trail in the kicker's place, "Editing"
                    // with the name as the accent, and the autosave state as the
                    // detail line (the mock's "unsaved changes" sub line).
                    DenScreenHeading(
                        kicker = "The Den · KinTale templates",
                        crumbs = listOf(
                            DenCrumb("KinTales"),
                            DenCrumb("Templates") {
                                viewModel.persist()
                                onBack()
                            },
                            DenCrumb(name),
                        ),
                        title = if (isNew) "New" else "Editing",
                        accentTail = if (isNew) "template." else name,
                        subtitle = "Shape the recap that goes home: which sections show, and the checklist Auntie fills out each visit.",
                        detail = autosaveLine(state.saveStatus, state.isSaving),
                    )

                    BasicSettingsSection(state, viewModel)

                    DenPanel(title = "Display sections", subtitle = "Which blocks appear in the recap.") {
                        Column {
                            DisplaySectionRow(
                                title = "Photo & video showcase",
                                description = "Allow attaching photos and videos to the KinTale.",
                                enabled = state.template.photoShowcaseEnabled,
                                onToggle = { viewModel.togglePhotoShowcase(it); viewModel.persist() }
                            )
                            DisplaySectionRow(
                                title = "Checklist",
                                description = "Per-pet and per-visit checklist items.",
                                enabled = state.template.checklistEnabled,
                                actionLabel = "Configure checklist items (${state.template.checklistItems.size})",
                                onToggle = { viewModel.toggleChecklist(it); viewModel.persist() },
                                onAction = onConfigureChecklist
                            )
                            DisplaySectionRow(
                                title = "Pet mood",
                                description = "Configure mood options that can be selected for each pet during visits.",
                                enabled = state.template.petMoodEnabled,
                                actionLabel = "Configure mood options (${state.template.moodOptions.size})",
                                onToggle = { viewModel.togglePetMood(it); viewModel.persist() },
                                onAction = onConfigureMoods
                            )
                            DisplaySectionRow(
                                title = "Visit notes",
                                description = "Free-text notes from Auntie to the kinfolk.",
                                enabled = state.template.visitNotesEnabled,
                                onToggle = { viewModel.toggleVisitNotes(it); viewModel.persist() }
                            )
                            DisplaySectionRow(
                                title = "Next appointment",
                                description = "Show the kinfolk's next booking with a Book Now nudge.",
                                enabled = state.template.nextAppointmentEnabled,
                                onToggle = { viewModel.toggleNextAppointment(it); viewModel.persist() }
                            )
                            DisplaySectionRow(
                                title = "Review booster",
                                description = "Embeds a review request section to encourage kinfolk to leave reviews.",
                                enabled = state.template.reviewBoosterEnabled,
                                actionLabel = "Configure review booster",
                                onToggle = { viewModel.toggleReviewBooster(it); viewModel.persist() },
                                onAction = onConfigureReviewBooster,
                                showDivider = false,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The autosave state as the band's detail line. The same four states the
 * scaffold badge paints, in words: the badge is a glance, this is the sentence.
 */
internal fun autosaveLine(status: SaveStatus, isSaving: Boolean): String = when {
    isSaving -> "Saving..."
    status == SaveStatus.SAVED -> "All changes saved"
    status == SaveStatus.ERROR -> "Save failed"
    else -> "Auto-saves on field blur"
}

@Composable
private fun BasicSettingsSection(
    state: TemplateEditorUiState,
    viewModel: KinTaleTemplateEditorViewModel
) {
    DenPanel(title = "Basic settings", subtitle = "Name it, and say when it applies.") {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            LabeledField(label = "Template name", helper = "Used for internal organization only.") {
                AuntieField(
                    value = state.template.name,
                    onValueChange = viewModel::updateName,
                    placeholder = "Default Pet Care Report",
                    modifier = Modifier
                        .fillMaxWidth()
                        .onFocusChanged { if (!it.isFocused) viewModel.persist() },
                )
            }

            LabeledField(label = "Description", helper = "Used for internal organization only.") {
                AuntieField(
                    value = state.template.description,
                    onValueChange = viewModel::updateDescription,
                    placeholder = "What kind of visits is this template for?",
                    singleLine = false,
                    modifier = Modifier
                        .fillMaxWidth()
                        .onFocusChanged { if (!it.isFocused) viewModel.persist() }
                )
            }

            LabeledField(
                label = "Default message to kinfolk",
                helper = "No default on purpose: the message is the story of the visit, and Auntie writes it fresh each time.",
            ) {
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

            // The mock's two toggle rows under the fields.
            Column {
                AuntieSettingRow(
                    title = "Make default template",
                    description = "Default templates are auto-selected when no service-specific template matches.",
                    trailing = {
                        AuntieToggle(
                            checked = state.template.isDefault,
                            onCheckedChange = {
                                viewModel.toggleIsDefault(it)
                                viewModel.persist()
                            },
                            enabled = !state.isOnlyDefault || !state.template.isDefault,
                        )
                    },
                )
                if (state.isOnlyDefault && state.template.isDefault) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Icon(Lucide.TriangleAlert, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "This is the only default template. Set another template as default before turning this off.",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )
                    }
                }
                AuntieSettingRow(
                    title = "Active",
                    description = "Inactive templates won't be selected by the composer.",
                    showDivider = false,
                    trailing = {
                        AuntieToggle(
                            checked = state.template.isActive,
                            onCheckedChange = {
                                viewModel.toggleIsActive(it)
                                viewModel.persist()
                            },
                        )
                    },
                )
            }
        }
    }
}

/**
 * The mock's `.trow`: the section's name and one line about it, the toggle at
 * the right. A section with its own editor (checklist, moods, review booster)
 * carries a link row under the toggle while it is on.
 */
@Composable
private fun DisplaySectionRow(
    title: String,
    description: String,
    enabled: Boolean,
    actionLabel: String? = null,
    onToggle: (Boolean) -> Unit,
    onAction: (() -> Unit)? = null,
    showDivider: Boolean = true,
) {
    Column {
        AuntieSettingRow(
            title = title,
            description = description,
            showDivider = showDivider && !(actionLabel != null && onAction != null && enabled),
            trailing = { AuntieToggle(checked = enabled, onCheckedChange = onToggle) },
        )
        if (actionLabel != null && onAction != null && enabled) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onAction)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
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
        AuntieFieldLabel(label)
        Spacer(Modifier.height(4.dp))
        content()
        if (!helper.isNullOrBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(helper, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        }
    }
}
