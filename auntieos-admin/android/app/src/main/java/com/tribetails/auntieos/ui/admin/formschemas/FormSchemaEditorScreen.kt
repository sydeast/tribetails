package com.tribetails.auntieos.ui.admin.formschemas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaAppliesTo
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieSaveBar
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.DynamicFormFields
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Den-redesign Form Schema editor (admin), matched to
 * ui-ideas/auntieos-formschema-editor-2026-05-27.html on the navy ground
 * (#755, 2026-09-12): the kit hero band with the clipboard tile, "New" or
 * "Edit form schema", the "{id} · v{version}" line as the band's detail and
 * the mock's "Unsaved" pill (its own suggestion, built) under it; the schema
 * inputs on the ground with no panel around them; a serif "Sections" bar
 * with "Add section" as a ghost button with a plus; one glass section card
 * per section with its "Fields (n)" bar and "Add field" ghost; the type chip
 * row; the conditional comma-separated Options line; the Yes / No segmented
 * picker for Required; fail-loud validation banners; and an AuntieSaveBar
 * footer. The two DenPanels that used to wrap the meta inputs and the
 * section list, each with a sentence of explanation under its title, are
 * gone: the mock draws neither, and the 2026-09-11 subtitle ruling struck
 * the sentences.
 *
 * The ViewModel contract is preserved verbatim (load / update* / move* / add* /
 * remove* / save / delete and the [FormSchemaEditorState] shape).
 */
@Composable
fun FormSchemaEditorScreen(
    schemaId: String?,
    onBack: () -> Unit,
    onDeleted: () -> Unit = onBack,
    viewModel: FormSchemaEditorViewModel = viewModel(),
) {
    val c = AuntieTheme.colors
    val state by viewModel.state.collectAsState()

    LaunchedEffect(schemaId) { viewModel.load(schemaId) }

    var showDeleteConfirm by remember { mutableStateOf(false) }

    val title = if (state.isNew) "New" else "Edit"
    // The mock's subtitle "{id} • v{version}" is a VALUE, so it is the band's
    // detail line, never the tooltip.
    val detail = when {
        state.name.isNotBlank() && state.schemaId.isNotBlank() ->
            "${state.schemaId} · v${state.originalVersion}"
        state.schemaId.isNotBlank() -> state.schemaId
        else -> null
    }

    // The mock's `.dirtypill` (its own suggestion, built): drawn in the band's
    // badge row only while there is something to save.
    val dirtyBadge: (@Composable () -> Unit)? = if (state.isDirty) {
        {
            AuntieStatusPill(
                label = "Unsaved",
                tone = AuntieStatusTone.Orange,
                mono = true,
                compact = true,
            )
        }
    } else {
        null
    }

    AuntieScreenScaffold(
        onBack = onBack,
        imePaddingEnabled = true,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            if (state.isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AuntieSpinner(modifier = Modifier.size(28.dp))
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp)
                        .testTag("form-schema-editor-list"),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                    contentPadding = PaddingValues(top = 12.dp, bottom = 140.dp),
                ) {
                    item {
                        DenScreenHeading(
                            kicker = "The Den · Form Schemas",
                            title = title,
                            accentTail = "form schema",
                            detail = detail,
                            // The mock's `.hicon`: the clipboard on the teal-to-purple
                            // brand gradient, 44dp on this screen.
                            leading = {
                                AuntieIconTile(
                                    icon = Lucide.ClipboardList,
                                    size = 44.dp,
                                    background = Brush.linearGradient(c.tealToPurpleColors),
                                )
                            },
                            badges = dirtyBadge,
                        )
                    }

                    // Persistent fail-loud banner for a save rejection (the toast
                    // auto-dismisses; a failed save must stay visible). Surfaces
                    // the full message the repository returns.
                    if (state.saveStatus == SaveStatus.FAILED && state.errorMessage != null) {
                        item {
                            AuntieBanner(
                                tone = AuntieBannerTone.Error,
                                title = "Could not save this schema",
                                icon = Lucide.TriangleAlert,
                                onDismiss = { viewModel.clearTransientMessages() },
                            ) {
                                Text(
                                    state.errorMessage.orEmpty(),
                                    color = c.error,
                                    style = AuntieTheme.typography.bodyMedium,
                                )
                            }
                        }
                    }

                    item { SchemaMetaFields(state = state, viewModel = viewModel) }

                    // The mock's `.secbar`: the serif "Sections" heading with "Add
                    // section" as a ghost button with a plus on the right, then the
                    // cards. No panel around the list.
                    item {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = "Sections",
                                    style = AuntieTheme.typography.headlineMedium,
                                    color = c.textPrimary,
                                )
                                GhostButton(
                                    label = "Add section",
                                    onClick = { viewModel.addSection() },
                                    leading = { PlusGlyph() },
                                )
                            }
                            if (state.sections.isEmpty()) {
                                EmptyHint("No sections yet. Use Add section to create one.")
                            }
                        }
                    }

                    itemsIndexed(state.sections, key = { i, _ -> "section-$i" }) { sectionIndex, section ->
                        SectionCard(
                            index = sectionIndex,
                            isFirst = sectionIndex == 0,
                            isLast = sectionIndex == state.sections.lastIndex,
                            title = section.title,
                            description = section.description,
                            fields = section.fields,
                            validationErrors = state.validationErrors,
                            viewModel = viewModel,
                        )
                    }

                    // Live preview: renders the in-progress schema through the SAME
                    // runtime renderer (DynamicFormFields) a kinfolk sees. Read-only
                    // preview state - the values map below is local sample/empty data
                    // and is NEVER persisted to the schema or repository.
                    item { LivePreviewPanel(sections = state.sections) }

                    // The mock's footer "Delete schema": a ghost with the coral trash,
                    // on the left of the row. Cancel and Save are the sticky save bar's.
                    if (!state.isNew && state.schemaId.isNotBlank()) {
                        item {
                            GhostButton(
                                label = "Delete schema",
                                onClick = { showDeleteConfirm = true },
                                leading = {
                                    androidx.compose.material3.Icon(
                                        Lucide.Trash2,
                                        contentDescription = null,
                                        tint = c.error,
                                        modifier = Modifier.size(14.dp),
                                    )
                                },
                            )
                        }
                    }
                }
            }

            // Sticky footer save bar. The ViewModel has no `canSave`; gate on the
            // in-flight save instead so an operator cannot double-submit, while a
            // not-dirty form still reads its clean status.
            AuntieSaveBar(
                dirty = state.isDirty,
                saveEnabled = state.saveStatus != SaveStatus.SAVING,
                onCancel = onBack,
                onSave = { viewModel.save() },
                saveLabel = if (state.saveStatus == SaveStatus.SAVING) "Saving…" else "Save",
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .testTag("form-schema-save-button"),
            )

            StatusToast(
                visible = state.errorMessage != null && state.saveStatus != SaveStatus.FAILED,
                message = state.errorMessage.orEmpty(),
                kind = ToastKind.Error,
                onDismiss = { viewModel.clearTransientMessages() },
                modifier = Modifier.padding(16.dp).align(Alignment.TopCenter),
            )
            StatusToast(
                visible = state.successMessage != null,
                message = state.successMessage.orEmpty(),
                kind = ToastKind.Success,
                onDismiss = { viewModel.clearTransientMessages() },
                modifier = Modifier.padding(16.dp).align(Alignment.TopCenter),
            )
        }
    }

    AuntieDialog(
        visible = showDeleteConfirm,
        title = "Delete schema",
        onDismiss = { showDeleteConfirm = false },
        footer = {
            GhostButton(label = "Cancel", onClick = { showDeleteConfirm = false })
            GhostButton(
                label = "Delete",
                onClick = {
                    showDeleteConfirm = false
                    viewModel.delete(onDeleted = onDeleted)
                },
            )
        },
    ) {
        Text(
            "Delete \"${state.name.ifBlank { state.schemaId }}\"? Kinfolk-side forms will fall back to static fields.",
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textDim,
        )
    }
}

/**
 * The mock's `.meta`: the schema id, name and description inputs on the
 * ground, 14dp apart, with nothing around them. "Applies to" is a shipped
 * field the concept predates and stays here with them.
 */
@Composable
private fun SchemaMetaFields(
    state: FormSchemaEditorState,
    viewModel: FormSchemaEditorViewModel,
) {
    // Schema-level validation (name / id / min-section) lives in the -1 bucket;
    // render it right under the meta inputs it concerns.
    val topErrors = FormSchemaValidator.errorsFor(state.validationErrors, -1, null)

    Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxWidth()) {
        FieldGroup(
            label = if (state.isNew) "Schema ID" else "Schema ID (immutable once persisted)",
            required = true,
        ) {
            BottomBorderField(
                value = state.schemaId,
                onValueChange = { viewModel.updateId(it) },
                label = "",
                placeholder = "tribeProfile",
                enabled = state.isNew,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        FieldGroup(label = "Name", required = true) {
            BottomBorderField(
                value = state.name,
                onValueChange = { viewModel.updateName(it) },
                label = "",
                placeholder = "Tribe Profile",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        FieldGroup(label = "Description", optionalNote = "optional") {
            BottomBorderField(
                value = state.description,
                onValueChange = { viewModel.updateDescription(it) },
                label = "",
                placeholder = "Optional admin-facing description",
                singleLine = false,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // 1C placement: which entity this schema attaches to. NONE = global
        // (Tribe Profile, Account Settings); entity targets replace the retired
        // dynamic_fields appliesTo.
        FieldGroup(label = "Applies to") {
            AuntieChipGroup(
                options = FormSchemaAppliesTo.ALL,
                selected = setOf(state.appliesTo),
                onSelectionChange = { sel -> sel.firstOrNull()?.let { viewModel.updateAppliesTo(it) } },
                label = { it },
                singleSelect = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (topErrors.isNotEmpty()) {
            ValidationBanner(messages = topErrors.map { it.message })
        }
    }
}

/**
 * Live preview pane (mockup right-column "live preview"). Renders the in-progress
 * schema through the SAME runtime [DynamicFormFields] renderer a kinfolk sees, so
 * the preview is faithful by construction and updates as fields change.
 *
 * Read-only by intent: the value map is local sample/empty preview data seeded by
 * [FormSchemaPreviewMapper] and is NEVER persisted back to the schema or the
 * repository. The operator may interact with inputs to feel the form, but those
 * edits live only in this throwaway map. An unknown field type is shown labeled
 * (the renderer's fail-loud text fallback), never hidden.
 */
@Composable
private fun LivePreviewPanel(sections: List<FormSchemaSection>) {
    DenPanel(
        title = "Live preview",
        subtitle = "How a kinfolk sees this form. Sample values only; nothing here is saved.",
        modifier = Modifier.fillMaxWidth().testTag("form-schema-live-preview"),
    ) {
        if (!FormSchemaPreviewMapper.hasRenderableFields(sections)) {
            EmptyHint("Add a field to see the live preview.")
            return@DenPanel
        }
        // Throwaway preview values: seeded from defaults, re-seeded whenever the
        // field keys change. Operator edits stay in this local map only.
        val previewSchema = FormSchemaPreviewMapper.previewSchema(sections)
        val seeded = FormSchemaPreviewMapper.previewValues(sections)
        val values = remember { mutableStateMapOf<String, String>() }
        val keySignature = seeded.keys.joinToString(",")
        LaunchedEffect(keySignature) {
            // Keep operator-entered preview values for keys that still exist; seed
            // any newly added keys; drop keys for removed fields.
            val retained = values.filterKeys { it in seeded.keys }
            values.clear()
            seeded.forEach { (k, v) -> values[k] = retained[k] ?: v }
        }
        DynamicFormFields(
            schemas = listOf(previewSchema),
            values = values,
            onValueChange = { key, value -> values[key] = value },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SectionCard(
    index: Int,
    isFirst: Boolean,
    isLast: Boolean,
    title: String,
    description: String?,
    fields: List<FormSchemaField>,
    validationErrors: List<FormSchemaValidationError>,
    viewModel: FormSchemaEditorViewModel,
) {
    val c = AuntieTheme.colors
    val sectionLevelErrors = FormSchemaValidator.errorsFor(validationErrors, index, null)

    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Section ${index + 1}",
                    style = AuntieTheme.typography.labelLarge,
                    color = c.textDim,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AuntieIconButton(
                        icon = Lucide.ArrowUp,
                        contentDescription = "Move section up",
                        enabled = !isFirst,
                        size = 26.dp,
                        onClick = { viewModel.moveSectionUp(index) },
                    )
                    AuntieIconButton(
                        icon = Lucide.ArrowDown,
                        contentDescription = "Move section down",
                        enabled = !isLast,
                        size = 26.dp,
                        onClick = { viewModel.moveSectionDown(index) },
                    )
                    AuntieIconButton(
                        icon = Lucide.Trash2,
                        contentDescription = "Remove section",
                        destructive = true,
                        size = 26.dp,
                        onClick = { viewModel.removeSection(index) },
                    )
                }
            }

            FieldGroup(label = "Section title", required = true) {
                BottomBorderField(
                    value = title,
                    onValueChange = { viewModel.updateSectionTitle(index, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            FieldGroup(label = "Section description", optionalNote = "optional") {
                BottomBorderField(
                    value = description.orEmpty(),
                    onValueChange = { viewModel.updateSectionDescription(index, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (sectionLevelErrors.isNotEmpty()) {
                ValidationBanner(messages = sectionLevelErrors.map { it.message })
            }

            // The mock's `.fldsbar`: the count on the left, "Add field" as a ghost
            // with a plus on the right, over the field cards.
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Fields (${fields.size})",
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                GhostButton(
                    label = "Add field",
                    onClick = { viewModel.addField(index) },
                    leading = { PlusGlyph() },
                    modifier = Modifier.testTag("add-field-$index"),
                )
            }

            if (fields.isEmpty()) {
                Text(
                    "No fields in this section yet.",
                    color = c.textFaint,
                    style = AuntieTheme.typography.bodySmall,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    fields.forEachIndexed { fieldIndex, field ->
                        FieldCard(
                            sectionIndex = index,
                            fieldIndex = fieldIndex,
                            isFirst = fieldIndex == 0,
                            isLast = fieldIndex == fields.lastIndex,
                            field = field,
                            validationErrors = FormSchemaValidator.errorsFor(validationErrors, index, fieldIndex),
                            viewModel = viewModel,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FieldCard(
    sectionIndex: Int,
    fieldIndex: Int,
    isFirst: Boolean,
    isLast: Boolean,
    field: FormSchemaField,
    validationErrors: List<FormSchemaValidationError>,
    viewModel: FormSchemaEditorViewModel,
) {
    val c = AuntieTheme.colors

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
                AuntieFieldLabel(text = "Field ${fieldIndex + 1}")
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AuntieIconButton(
                        icon = Lucide.ArrowUp,
                        contentDescription = "Move field up",
                        enabled = !isFirst,
                        size = 26.dp,
                        onClick = { viewModel.moveFieldUp(sectionIndex, fieldIndex) },
                    )
                    AuntieIconButton(
                        icon = Lucide.ArrowDown,
                        contentDescription = "Move field down",
                        enabled = !isLast,
                        size = 26.dp,
                        onClick = { viewModel.moveFieldDown(sectionIndex, fieldIndex) },
                    )
                    AuntieIconButton(
                        icon = Lucide.Trash2,
                        contentDescription = "Remove field",
                        destructive = true,
                        size = 26.dp,
                        onClick = { viewModel.removeField(sectionIndex, fieldIndex) },
                    )
                }
            }

            FieldGroup(label = "Field key", required = true) {
                BottomBorderField(
                    value = field.key,
                    onValueChange = { viewModel.updateFieldKey(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            FieldGroup(label = "Label", required = true) {
                BottomBorderField(
                    value = field.label,
                    onValueChange = { viewModel.updateFieldLabel(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            AuntieFieldLabel(text = "Type")
            FieldTypeChipRow(
                selected = FormSchemaFieldType.fromWire(field.type) ?: FormSchemaFieldType.TEXT,
                onSelect = { viewModel.updateFieldType(sectionIndex, fieldIndex, it) },
            )

            // The mock's "Options (comma-separated) *" line. The view model already
            // splits on commas as well as newlines, so the label and the value agree.
            if (FormSchemaFieldType.requiresOptions(field.type)) {
                FieldGroup(label = "Options (comma-separated)", required = true) {
                    BottomBorderField(
                        value = field.options.orEmpty().joinToString(", "),
                        onValueChange = { viewModel.updateFieldOptions(sectionIndex, fieldIndex, it) },
                        label = "",
                        placeholder = "Small, Medium, Large",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            FieldGroup(label = "Helper text", optionalNote = "optional") {
                BottomBorderField(
                    value = field.helperText.orEmpty(),
                    onValueChange = { viewModel.updateFieldHelperText(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            FieldGroup(label = "Placeholder", optionalNote = "optional") {
                BottomBorderField(
                    value = field.placeholder.orEmpty(),
                    onValueChange = { viewModel.updateFieldPlaceholder(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            FieldGroup(label = "Default value", optionalNote = "optional") {
                BottomBorderField(
                    value = field.defaultValue.orEmpty(),
                    onValueChange = { viewModel.updateFieldDefaultValue(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            FieldGroup(label = "Group", optionalNote = "optional") {
                BottomBorderField(
                    value = field.group.orEmpty(),
                    onValueChange = { viewModel.updateFieldGroup(sectionIndex, fieldIndex, it) },
                    label = "",
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // The mock's `.reqrow`: "Required" with a Yes / No segmented picker,
            // the chosen half cream on navy, not a toggle.
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Required", style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                SegmentedPicker(
                    options = listOf(true, false),
                    selected = field.required,
                    onSelect = { viewModel.updateFieldRequired(sectionIndex, fieldIndex, it) },
                    label = { if (it) "Yes" else "No" },
                )
            }

            if (validationErrors.isNotEmpty()) {
                ValidationBanner(messages = validationErrors.map { it.message })
            }
        }
    }
}

/**
 * Den pill row for the field type. One [AuntieChipGroup] in single-select mode,
 * one chip per supported [FormSchemaFieldType], rendered by display label.
 */
@Composable
private fun FieldTypeChipRow(
    selected: FormSchemaFieldType,
    onSelect: (FormSchemaFieldType) -> Unit,
) {
    AuntieChipGroup(
        options = FormSchemaFieldType.entries,
        selected = setOf(selected),
        onSelectionChange = { next -> next.firstOrNull()?.let(onSelect) },
        label = { it.displayLabel },
        singleSelect = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** The plus the mock draws inside its "Add section" and "Add field" ghosts. */
@Composable
private fun PlusGlyph() {
    androidx.compose.material3.Icon(
        imageVector = Lucide.Plus,
        contentDescription = null,
        modifier = Modifier.size(14.dp),
    )
}

/**
 * Den form field group: a mono [AuntieFieldLabel] caption stacked over the
 * caller's input ([content]). Keeps the Den caption styling consistent while
 * letting [BottomBorderField] own the input chrome.
 */
@Composable
private fun FieldGroup(
    label: String,
    modifier: Modifier = Modifier,
    required: Boolean = false,
    optionalNote: String? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        AuntieFieldLabel(text = label, required = required, optionalNote = optionalNote)
        content()
    }
}

/**
 * Den fail-loud validation banner: error tone, left accent rail, triangle glyph.
 * Validation copy comes verbatim from [FormSchemaValidator]; the caller owns it.
 */
@Composable
private fun ValidationBanner(messages: List<String>) {
    val c = AuntieTheme.colors
    AuntieBanner(tone = AuntieBannerTone.Error, icon = Lucide.TriangleAlert) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            messages.forEach { msg ->
                Text(msg, color = c.error, style = AuntieTheme.typography.bodySmall)
            }
        }
    }
}
