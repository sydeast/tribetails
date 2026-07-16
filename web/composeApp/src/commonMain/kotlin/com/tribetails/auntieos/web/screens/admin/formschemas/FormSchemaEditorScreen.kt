package com.tribetails.auntieos.web.screens.admin.formschemas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.FormSectionSpec
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DynamicFormFields
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.launch

// Mockup right-column "live preview" pane. Renders the schema exactly as a kinfolk
// would see it via the shared runtime renderer (DynamicFormFields, the same widget
// tree behind BookingScreen / KinEdit / KinfolkEdit / KinTaleCompose). The editor's
// in-progress FormSchema is reconciled by formSchemaPreviewModel and fed straight
// to the renderer, so the preview updates live as fields change. Preview edits are
// throwaway local state and are never persisted.

/**
 * Den-redesign Form Schema editor (admin). Mirrors
 * ui-ideas/auntieos-formschema-editor-2026-05-27.html: a mono kicker + serif
 * heading with a "Back" trailing action and an "Unsaved" dirty pill, glass
 * DenPanels for the schema meta and each section/field, the 9-type chip row,
 * the conditional Options field, the Required Yes/No picker, and fail-loud
 * validation banners + a save/delete status toast.
 *
 * [schemaId] is the list-screen handoff: blank or the "new" sentinel = create
 * mode (immutable id input is editable), any other value = edit that schema.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FormSchemaEditorScreen(
    schemaId: String,
    repository: FormSchemaRepository = remember { CloudFormSchemaRepository() },
    onBack: () -> Unit,
    viewModel: FormSchemaEditorViewModel = remember(repository) { FormSchemaEditorViewModel(repository) },
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    val state by viewModel.state.collectAsState()
    var confirmDelete by remember { mutableStateOf(false) }
    val creating = isCreateMode(schemaId)

    // Throwaway local state for the live preview pane. A kinfolk filling out the
    // form would type into these inputs; here they are sample values that never
    // persist (no ViewModel write, no repository call). Seeded from operator
    // defaults via formSchemaPreviewModel.
    val previewValues = remember { mutableStateMapOf<String, String>() }

    LaunchedEffect(schemaId) {
        viewModel.load(schemaId)
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Form Schemas",
            title      = if (creating) "New" else "Edit",
            accentTail = "form schema",
            subtitle   = if (state.schema.id.isNotBlank()) "${state.schema.id} · v${state.schema.version}" else null,
            trailing = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // Surfaces the EditorState.isDirty flag as an "Unsaved" pill,
                    // matching the mockup's dirty affordance.
                    if (state.isDirty) {
                        AuntieStatusPill(
                            label = "Unsaved",
                            tone  = AuntieStatusTone.Orange,
                            mono  = true,
                        )
                    }
                    GhostButton(
                        label = "Back",
                        onClick = onBack,
                        leading = { Icon(Lucide.ArrowLeft, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.textDim) },
                    )
                }
            },
        )
        Spacer(Modifier.height(20.dp))

        // ── save / delete status (fail-loud) ─────────────────────────────────
        when (val s = state.saveStatus) {
            is SaveStatus.Success -> {
                StatusToast(visible = true, message = s.message, kind = ToastKind.Success, onDismiss = { viewModel.clearStatus() })
                Spacer(Modifier.height(12.dp))
            }
            is SaveStatus.Error -> {
                // Persistent fail-loud banner (the toast auto-dismisses; a save
                // rejection must stay visible). Surfaces the full message the
                // repository returns, including any backend Zod detail it forwards.
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Could not save this schema",
                    icon  = Lucide.TriangleAlert,
                    onDismiss = { viewModel.clearStatus() },
                ) {
                    Text(s.message, color = c.error, style = AuntieTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(12.dp))
            }
            else -> Unit
        }

        if (state.isLoading) {
            EmptyHint("Loading schema…")
            return@ScreenScaffold
        }

        // ── schema meta ──────────────────────────────────────────────────────
        DenPanel(
            title    = "Schema details",
            subtitle = "Identifier, display name, and an optional admin-facing description.",
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxWidth()) {
                BottomBorderField(
                    value         = state.schema.id,
                    onValueChange = { viewModel.updateId(it) },
                    label         = if (creating) "Schema ID *" else "Schema ID * (immutable once persisted)",
                    placeholder   = "tribeProfile",
                    enabled       = creating, // id is immutable once persisted
                    modifier      = Modifier.fillMaxWidth(),
                )
                BottomBorderField(
                    value         = state.schema.name,
                    onValueChange = { viewModel.updateName(it) },
                    label         = "Name *",
                    placeholder   = "Tribe Profile",
                    modifier      = Modifier.fillMaxWidth(),
                )
                MultilineField(
                    value         = state.schema.description.orEmpty(),
                    onValueChange = { viewModel.updateDescription(it) },
                    label         = "Description",
                    placeholder   = "Optional admin-facing description",
                    minLines      = 2,
                    modifier      = Modifier.fillMaxWidth(),
                )
                // 1C placement: which entity this schema attaches to. NONE = global
                // (Tribe Profile, Account Settings); the entity targets replace the
                // retired dynamic_fields `appliesTo`.
                AuntieFieldLabel(text = "Applies to")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    FormSchema.APPLIES_TO.forEach { target ->
                        AuntieChip(
                            label    = target,
                            selected = state.schema.appliesTo == target,
                            onClick  = { viewModel.updateAppliesTo(target) },
                            tone     = AuntieChipTone.Orange,
                        )
                    }
                }
            }

            // Schema-level validation (name/id/min-section/plaintext) lives in the
            // -1 bucket; render it right under the meta inputs it concerns.
            val topErrors = state.validation.sectionErrors[-1].orEmpty()
            if (topErrors.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                ValidationBanner(messages = topErrors)
            }
        }

        Spacer(Modifier.height(20.dp))

        // ── sections ───────────────────────────────────────────────────────
        DenPanel(
            title    = "Sections",
            subtitle = "Each section groups the fields a kinfolk fills in. Need at least one section, each with at least one field.",
            modifier = Modifier.fillMaxWidth(),
            trailing = {
                GhostButton(
                    label = "Add section",
                    onClick = { viewModel.addNewSection() },
                    leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.textDim) },
                )
            },
        ) {
            if (state.schema.sections.isEmpty()) {
                EmptyHint("No sections yet. Use Add section to create one.")
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    state.schema.sections.forEachIndexed { sIdx, section ->
                        SectionCard(
                            section       = section,
                            sectionIdx    = sIdx,
                            totalSections = state.schema.sections.size,
                            sectionErrors = state.validation.sectionErrors[sIdx].orEmpty(),
                            fieldErrors   = state.validation.fieldErrors,
                            viewModel     = viewModel,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(20.dp))

        // ── live preview ─────────────────────────────────────────────────────
        LivePreviewPanel(
            schema        = state.schema,
            previewValues = previewValues,
        )
        Spacer(Modifier.height(20.dp))

        // ── footer actions ───────────────────────────────────────────────────
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state.schema.id.isNotBlank() && !creating) {
                GhostButton(
                    label = if (confirmDelete) "Tap to confirm delete" else "Delete schema",
                    onClick = {
                        if (confirmDelete) {
                            scope.launch {
                                viewModel.delete()
                                confirmDelete = false
                                onBack()
                            }
                        } else {
                            confirmDelete = true
                        }
                    },
                    leading = { Icon(Lucide.Trash2, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.error) },
                )
            }
            Spacer(Modifier.weight(1f))
            GhostButton(
                label = "Cancel",
                onClick = { confirmDelete = false; onBack() },
            )
            PrimaryButton(
                label   = if (state.saveStatus == SaveStatus.Saving) "Saving…" else "Save",
                enabled = state.canSave,
                loading = state.saveStatus == SaveStatus.Saving,
                onClick = { scope.launch { viewModel.save() } },
            )
        }
    }
}

/**
 * Right-column live preview. Reconciles the in-progress [schema] through the pure
 * [formSchemaPreviewModel] and renders it with the shared runtime [DynamicFormFields]
 * (the same widget tree kinfolk fill out). Edits land in throwaway [previewValues]
 * and are never persisted. Unknown field types are surfaced labeled by the mapper,
 * never hidden.
 */
@Composable
private fun LivePreviewPanel(
    schema: FormSchema,
    previewValues: SnapshotStateMap<String, String>,
) {
    val c = AuntieTheme.colors
    val model = formSchemaPreviewModel(schema)

    // Seed operator-default sample values once they appear, without clobbering
    // anything already typed into the preview. Pure mapper output drives this.
    LaunchedEffect(model.values) {
        model.values.forEach { (k, v) ->
            if (k !in previewValues) previewValues[k] = v
        }
    }

    DenPanel(
        title    = "Live preview",
        subtitle = "Exactly what a kinfolk sees. Sample input here is not saved.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        val hasFields = model.schema.sections.any { it.fields.isNotEmpty() }
        if (!hasFields) {
            EmptyHint("Add a section with at least one field to see the preview.")
        } else {
            DynamicFormFields(
                schemas       = listOf(model.schema),
                values        = previewValues,
                onValueChange = { key, value -> previewValues[key] = value },
                modifier      = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun SectionCard(
    section: FormSectionSpec,
    sectionIdx: Int,
    totalSections: Int,
    sectionErrors: List<String>,
    fieldErrors: Map<Pair<Int, Int>, List<String>>,
    viewModel: FormSchemaEditorViewModel,
) {
    val c = AuntieTheme.colors
    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // ---- header row: title + reorder + delete ----
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Section ${sectionIdx + 1}",
                    style = AuntieTheme.typography.labelLarge,
                    color = c.textDim,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    AuntieIconButton(
                        icon               = Lucide.ArrowUp,
                        contentDescription = "Move up",
                        enabled            = sectionIdx > 0,
                        size               = 26.dp,
                        onClick            = { viewModel.bumpSectionUp(sectionIdx) },
                    )
                    AuntieIconButton(
                        icon               = Lucide.ArrowDown,
                        contentDescription = "Move down",
                        enabled            = sectionIdx < totalSections - 1,
                        size               = 26.dp,
                        onClick            = { viewModel.bumpSectionDown(sectionIdx) },
                    )
                    AuntieIconButton(
                        icon               = Lucide.Trash2,
                        contentDescription = "Delete section",
                        destructive        = true,
                        size               = 26.dp,
                        onClick            = { viewModel.deleteSection(sectionIdx) },
                    )
                }
            }

            BottomBorderField(
                value         = section.title,
                onValueChange = { viewModel.updateSectionTitle(sectionIdx, it) },
                label         = "Section title *",
                isError       = sectionErrors.isNotEmpty(),
                modifier      = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value         = section.description.orEmpty(),
                onValueChange = { viewModel.updateSectionDescription(sectionIdx, it) },
                label         = "Section description",
                modifier      = Modifier.fillMaxWidth(),
            )

            if (sectionErrors.isNotEmpty()) {
                ValidationBanner(messages = sectionErrors)
            }

            // ---- fields ----
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Fields (${section.fields.size})",
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                GhostButton(
                    label   = "Add field",
                    onClick = { viewModel.addNewField(sectionIdx) },
                    leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.textDim) },
                )
            }

            if (section.fields.isEmpty()) {
                Text(
                    "No fields in this section yet.",
                    color = c.textFaint,
                    style = AuntieTheme.typography.bodySmall,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    section.fields.forEachIndexed { fIdx, field ->
                        FieldCard(
                            field       = field,
                            sectionIdx  = sectionIdx,
                            fieldIdx    = fIdx,
                            totalFields = section.fields.size,
                            errors      = fieldErrors[sectionIdx to fIdx].orEmpty(),
                            viewModel   = viewModel,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FieldCard(
    field: FormFieldSpec,
    sectionIdx: Int,
    fieldIdx: Int,
    totalFields: Int,
    errors: List<String>,
    viewModel: FormSchemaEditorViewModel,
) {
    val c = AuntieTheme.colors
    val hasErrors = errors.isNotEmpty()
    // The inner field card reads as a recessed surface tile; in the mockup the
    // error state simply re-tints the hairline border to the brand error color.
    GlassSurface(cornerRadius = 12.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Field ${fieldIdx + 1}",
                    style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 0.8.sp),
                    color = c.textDim,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    AuntieIconButton(
                        icon               = Lucide.ArrowUp,
                        contentDescription = "Move field up",
                        enabled            = fieldIdx > 0,
                        size               = 26.dp,
                        onClick            = { viewModel.bumpFieldUp(sectionIdx, fieldIdx) },
                    )
                    AuntieIconButton(
                        icon               = Lucide.ArrowDown,
                        contentDescription = "Move field down",
                        enabled            = fieldIdx < totalFields - 1,
                        size               = 26.dp,
                        onClick            = { viewModel.bumpFieldDown(sectionIdx, fieldIdx) },
                    )
                    AuntieIconButton(
                        icon               = Lucide.Trash2,
                        contentDescription = "Delete field",
                        destructive        = true,
                        size               = 26.dp,
                        onClick            = { viewModel.deleteField(sectionIdx, fieldIdx) },
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                BottomBorderField(
                    value         = field.key,
                    onValueChange = { viewModel.updateFieldKey(sectionIdx, fieldIdx, it) },
                    label         = "Field key *",
                    isError       = hasErrors,
                    modifier      = Modifier.weight(1f),
                )
                BottomBorderField(
                    value         = field.label,
                    onValueChange = { viewModel.updateFieldLabel(sectionIdx, fieldIdx, it) },
                    label         = "Label *",
                    isError       = hasErrors,
                    modifier      = Modifier.weight(1f),
                )
            }

            Text(
                text  = "TYPE",
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
            )
            FieldTypeChipRow(
                selected = field.type,
                onSelect = { viewModel.updateFieldType(sectionIdx, fieldIdx, it) },
            )

            if (FormSchema.typeRequiresOptions(field.type)) {
                BottomBorderField(
                    value         = field.options.orEmpty().joinToString(", "),
                    onValueChange = { viewModel.updateFieldOptionsFromCsv(sectionIdx, fieldIdx, it) },
                    label         = "Options (comma-separated) *",
                    placeholder   = "Small, Medium, Large",
                    isError       = hasErrors,
                    modifier      = Modifier.fillMaxWidth(),
                )
            }

            BottomBorderField(
                value         = field.helperText.orEmpty(),
                onValueChange = { viewModel.updateFieldHelperText(sectionIdx, fieldIdx, it) },
                label         = "Helper text",
                modifier      = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value         = field.placeholder.orEmpty(),
                onValueChange = { viewModel.updateFieldPlaceholder(sectionIdx, fieldIdx, it) },
                label         = "Placeholder",
                modifier      = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value         = field.defaultValue.orEmpty(),
                onValueChange = { viewModel.updateFieldDefaultValue(sectionIdx, fieldIdx, it) },
                label         = "Default value",
                modifier      = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value         = field.group.orEmpty(),
                onValueChange = { viewModel.updateFieldGroup(sectionIdx, fieldIdx, it) },
                label         = "Group",
                modifier      = Modifier.fillMaxWidth(),
            )

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Required", style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                SegmentedPicker(
                    options  = listOf(true, false),
                    selected = field.required,
                    onSelect = { viewModel.updateFieldRequired(sectionIdx, fieldIdx, it) },
                    label    = { if (it) "Yes" else "No" },
                )
            }

            if (errors.isNotEmpty()) {
                ValidationBanner(messages = errors)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FieldTypeChipRow(
    selected: String,
    onSelect: (String) -> Unit,
) {
    // Den pill row: one AuntieChip per supported type, mono + Orange accent on the
    // active pill. FlowRow wraps the 9 SUPPORTED_TYPES like the mockup chip cluster.
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        FormSchema.SUPPORTED_TYPES.forEach { type ->
            AuntieChip(
                label    = type,
                selected = type == selected,
                onClick  = { onSelect(type) },
                tone     = AuntieChipTone.Orange,
                mono     = true,
            )
        }
    }
}

@Composable
private fun ValidationBanner(messages: List<String>) {
    val c = AuntieTheme.colors
    // Den fail-loud banner: error tone, left accent rail. Validation copy comes
    // verbatim from validateFormSchema (FormSchemaHelpers.kt); the caller owns it.
    AuntieBanner(tone = AuntieBannerTone.Error, icon = Lucide.TriangleAlert) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            messages.forEach { msg ->
                Text(msg, color = c.error, style = AuntieTheme.typography.bodySmall)
            }
        }
    }
}
