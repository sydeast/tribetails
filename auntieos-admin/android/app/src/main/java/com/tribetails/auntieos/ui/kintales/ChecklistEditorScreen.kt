package com.tribetails.auntieos.ui.kintales

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.ConditionOp
import com.tribetails.auntieos.data.model.ConditionSource
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun ChecklistEditorScreen(
    templateId: String?,
    onBack: () -> Unit,
    viewModel: KinTaleTemplateEditorViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsState()
    val bank by viewModel.bank.collectAsState()
    LaunchedEffect(templateId) {
        viewModel.load(templateId)
        viewModel.loadBank()
    }

    // I7: the household tag vocabulary backs the KINFOLK_TAG condition picker, so a
    // rule can only target a tag the operator actually manages. Read straight from
    // the repository (the editor ViewModel owns templates, not settings); the
    // vocabulary itself is edited in the Tags settings panel.
    var householdTags by remember { mutableStateOf<List<TagDef>>(emptyList()) }
    var tagVocabError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        AuntieOSApp.instance.repository.getBusinessSettings().fold(
            onSuccess = { householdTags = it.householdTagDefs(); tagVocabError = null },
            // Fail loud: an empty picker would read as "you have no tags", which is
            // a different and wrong answer from "we could not load them".
            onFailure = { tagVocabError = it.message ?: "Load failed" },
        )
    }

    val perPet = state.template.checklistItems
        .filter { it.scope == ChecklistScope.PER_PET.name }
        .sortedBy { it.order }
    val perVisit = state.template.checklistItems
        .filter { it.scope == ChecklistScope.PER_VISIT.name }
        .sortedBy { it.order }

    // #1593: Back and Save Changes both save, and a checklist with a blank item
    // is never written. Rather than drop the item or the typing, the operator
    // stays here and every blank item says why. The system back gesture takes
    // the same road as the arrow; it used to pop without saving at all.
    val saveAndLeave: () -> Unit = { if (viewModel.persist(reveal = true)) onBack() }
    BackHandler(onBack = saveAndLeave)
    val flagged = state.flaggedChecklistIds
    val canAdd = state.checklistHasRoom

    AuntieScreenScaffold(
        title = "Configure Checklist",
        onBack = saveAndLeave,
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
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Checklist Items (${state.template.checklistItems.size})",
                            style = AuntieTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f)
                        )
                        PrimaryButton(
                            label = "Add Item",
                            onClick = { viewModel.addChecklistItem(ChecklistScope.PER_PET) },
                            enabled = canAdd,
                            leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(18.dp)) }
                        )
                    }
                    if (!canAdd) ChecklistLimitNote()

                    state.error?.let { message ->
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            onDismiss = viewModel::clearError,
                        ) {
                            Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                        }
                    }

                    tagVocabError?.let { message ->
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            title = "Couldn't load your household tags",
                        ) {
                            Text(
                                "$message. Household tag conditions fall back to a typed tag name.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }

                    ChecklistGroup(
                        heading = "Per Pet Items",
                        count = perPet.size,
                        helperText = "These items will appear once for each pet in the service",
                        icon = Lucide.User,
                        items = perPet,
                        bankAvailable = bankItemsNotInChecklist(bank, state.template.checklistItems)
                            .filter { it.scope == ChecklistScope.PER_PET.name },
                        flagged = flagged,
                        canAdd = canAdd,
                        onUpdate = viewModel::updateChecklistItem,
                        onDelete = { viewModel.removeChecklistItem(it); viewModel.persist() },
                        onPersist = { viewModel.persist() },
                        onLeave = viewModel::leaveChecklistItem,
                        onAdd = { viewModel.addChecklistItem(ChecklistScope.PER_PET) },
                        onAddFromBank = { viewModel.addFromBank(it); viewModel.persist() },
                        onSaveToBank = { viewModel.saveItemToBank(it.text, it.scope) },
                        householdTags = householdTags,
                    )

                    ChecklistGroup(
                        heading = "Per Visit Items",
                        count = perVisit.size,
                        helperText = "These items will appear once per visit, regardless of how many pets are in the service",
                        icon = Lucide.ListPlus,
                        items = perVisit,
                        bankAvailable = bankItemsNotInChecklist(bank, state.template.checklistItems)
                            .filter { it.scope == ChecklistScope.PER_VISIT.name },
                        flagged = flagged,
                        canAdd = canAdd,
                        onUpdate = viewModel::updateChecklistItem,
                        onDelete = { viewModel.removeChecklistItem(it); viewModel.persist() },
                        onPersist = { viewModel.persist() },
                        onLeave = viewModel::leaveChecklistItem,
                        onAdd = { viewModel.addChecklistItem(ChecklistScope.PER_VISIT) },
                        onAddFromBank = { viewModel.addFromBank(it); viewModel.persist() },
                        onSaveToBank = { viewModel.saveItemToBank(it.text, it.scope) },
                        householdTags = householdTags,
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.background)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // #1593: Save Changes is off only while its reason is on screen,
            // and the reason sits right here beside it.
            val blockedReason = state.saveBlockedReason
            if (blockedReason != null) {
                Text(
                    blockedReason,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
            }
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
                    onClick = saveAndLeave,
                    enabled = blockedReason == null,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun ChecklistGroup(
    heading: String,
    count: Int,
    helperText: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    items: List<ChecklistItem>,
    bankAvailable: List<com.tribetails.auntieos.data.model.ChecklistBankItem>,
    flagged: Set<String>,
    canAdd: Boolean,
    onUpdate: (ChecklistItem) -> Unit,
    onDelete: (key: String) -> Unit,
    onPersist: () -> Unit,
    onLeave: (ChecklistItem) -> Unit,
    onAdd: () -> Unit,
    onAddFromBank: (com.tribetails.auntieos.data.model.ChecklistBankItem) -> Unit,
    onSaveToBank: (ChecklistItem) -> Unit,
    householdTags: List<TagDef>,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            "$heading ($count)",
            style = AuntieTheme.typography.titleSmall,
            color = AuntieTheme.colors.kinfolkOrange,
            fontWeight = FontWeight.SemiBold
        )
        Text(helperText, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)

        if (items.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(AuntieTheme.colors.surface)
                    .padding(20.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    "No items in this group yet.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
        } else {
            items.forEach { item ->
                ChecklistItemEditor(
                    item = item,
                    icon = icon,
                    onUpdate = onUpdate,
                    onDelete = onDelete,
                    onPersist = onPersist,
                    onSaveToBank = onSaveToBank,
                    householdTags = householdTags,
                    showBlankError = checklistItemId(item) in flagged,
                    onLeave = { onLeave(item) },
                )
            }
        }

        val addTint = if (canAdd) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim
        AuntieTextBtn(onClick = onAdd, enabled = canAdd) {
            Icon(Lucide.Plus, contentDescription = null, tint = addTint)
            Spacer(Modifier.width(6.dp))
            Text("Add ${heading.lowercase().removeSuffix(" items")}", color = addTint)
        }
        if (!canAdd) ChecklistLimitNote()

        // Run-4 #7b: "Add from bank" of common items not already in this group.
        // A full checklist (#1593) offers none; the note above says why.
        if (bankAvailable.isNotEmpty() && canAdd) {
            Text(
                "ADD FROM BANK",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
            bankAvailable.forEach { bi ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onAddFromBank(bi) }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Lucide.Plus, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(bi.text, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                }
            }
        }
    }
}

@Composable
internal fun ChecklistItemEditor(
    item: ChecklistItem,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onUpdate: (ChecklistItem) -> Unit,
    onDelete: (key: String) -> Unit,
    onPersist: () -> Unit,
    onSaveToBank: (ChecklistItem) -> Unit,
    householdTags: List<TagDef>,
    /** #1593: the text is blank and its message is due. */
    showBlankError: Boolean = false,
    /** #1593: focus went into the text field and came back out. */
    onLeave: () -> Unit = {},
) {
    // The field reports "unfocused" once when it first composes, so only a
    // focused-then-unfocused change counts as leaving it. Without this a new
    // item would be told off the instant it was added.
    var hadFocus by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(
                Lucide.GripVertical,
                contentDescription = "Reorder",
                tint = AuntieTheme.colors.textDim,
                modifier = Modifier.padding(top = 14.dp)
            )
            Spacer(Modifier.width(8.dp))

            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        AuntieField(
                            value = item.text,
                            onValueChange = { onUpdate(item.copy(text = it)) },
                            label = "Item Text",
                            isError = showBlankError,
                            modifier = Modifier
                                .fillMaxWidth()
                                .onFocusChanged {
                                    if (it.isFocused) {
                                        hadFocus = true
                                    } else {
                                        if (hadFocus) onLeave()
                                        onPersist()
                                    }
                                },
                        )
                        if (showBlankError) {
                            Text(
                                CHECKLIST_ITEM_BLANK,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.error,
                            )
                        }
                    }
                    AuntieDropdownField(
                        value = ChecklistScope.values().firstOrNull { it.name == item.scope },
                        options = ChecklistScope.values().toList(),
                        onSelect = { scope ->
                            onUpdate(item.copy(scope = scope.name))
                            onPersist()
                        },
                        displayText = { scopeLabel(it.name) },
                        label = "Show",
                        modifier = Modifier.weight(1f)
                    )
                }

                // `required` is written by both web editors and rides along on every
                // android save, so without this row the phone silently edits a flag it
                // never shows. Named for accessibility to match React's switch, whose
                // accessible name is "Required".
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AuntieToggle(
                        checked = item.required,
                        onCheckedChange = {
                            onUpdate(item.copy(required = it))
                            onPersist()
                        },
                        modifier = Modifier.semantics { contentDescription = "Required" },
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Required", style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        Text(
                            "Mark this item as one Auntie must fill in.",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    AuntieToggle(
                        checked = item.showWhenUnchecked,
                        onCheckedChange = {
                            onUpdate(item.copy(showWhenUnchecked = it))
                            onPersist()
                        },
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Show unchecked response", style = AuntieTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        Text(
                            "Unchecked items default to being hidden in the report card. If this is enabled, an unchecked response will be displayed.",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim
                        )
                    }
                }

                ChecklistConditionsEditor(
                    item = item,
                    householdTags = householdTags,
                    onUpdate = onUpdate,
                    onPersist = onPersist,
                )
            }

            Column {
                // Run-4 #7b: save this custom item to the shared bank (once it has text).
                if (item.text.isNotBlank()) {
                    AuntieIconBtn(onClick = { onSaveToBank(item) }) {
                        Icon(Lucide.Save, contentDescription = "Save to bank", tint = AuntieTheme.colors.kinfolkOrange)
                    }
                }
                AuntieIconBtn(onClick = { onDelete(item.key) }) {
                    Icon(Lucide.Trash2, contentDescription = "Delete", tint = AuntieTheme.colors.error)
                }
            }
        }
    }
}

/** #1593: under a disabled Add item, the reason it is off. */
@Composable
private fun ChecklistLimitNote() {
    Text(
        CHECKLIST_LIMIT_REACHED,
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.textDim,
    )
}

private fun scopeLabel(scope: String): String = when (scope) {
    ChecklistScope.PER_PET.name -> "Once per pet"
    ChecklistScope.PER_VISIT.name -> "Once per visit"
    else -> scope
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditional visibility editor. Lets Auntie say e.g. "only show 'Litter box
// scooped' for cats" or "only show 'Meds given' for kin with medication notes".
// Writes FieldConditions onto the item; an empty list = always shown. The same
// engine (KinTaleTemplateEngine) evaluates these in the report composer + on web.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChecklistConditionsEditor(
    item: ChecklistItem,
    householdTags: List<TagDef>,
    onUpdate: (ChecklistItem) -> Unit,
    onPersist: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "CONDITIONS",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim,
        )
        if (item.conditions.isEmpty()) {
            Text(
                "Always shown. Add a condition to show this item only for certain pets, services, or households.",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
        } else {
            item.conditions.forEachIndexed { idx, cond ->
                ConditionRow(
                    condition = cond,
                    householdTags = householdTags,
                    onChange = { updated ->
                        onUpdate(item.copy(conditions = item.conditions.mapIndexed { i, x -> if (i == idx) updated else x }))
                    },
                    onPersist = onPersist,
                    onRemove = {
                        onUpdate(item.copy(conditions = item.conditions.filterIndexed { i, _ -> i != idx }))
                        onPersist()
                    },
                )
            }
        }
        AuntieTextBtn(onClick = {
            onUpdate(
                item.copy(
                    conditions = item.conditions + FieldCondition(
                        source = ConditionSource.KIN_SPECIES.name,
                        op = ConditionOp.EQUALS.name,
                        value = "",
                    ),
                ),
            )
            onPersist()
        }) {
            Icon(Lucide.Plus, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
            Spacer(Modifier.width(6.dp))
            Text("Add condition", color = AuntieTheme.colors.kinfolkOrange)
        }
    }
}

/**
 * One condition row: When (source) / Is (op), then the input the pair calls for.
 *
 * The pickers are keyed on the raw wire STRINGS, not the Kotlin enums, so a source
 * or op this build does not model (authored by a newer app, or by the React admin)
 * stays selected and labelled "(unrecognised)" instead of silently snapping to
 * KIN_SPECIES and being rewritten on the next save. The picking logic itself lives
 * in the pure helpers at the bottom of this file; this is the render shell.
 */
@Composable
private fun ConditionRow(
    condition: FieldCondition,
    householdTags: List<TagDef>,
    onChange: (FieldCondition) -> Unit,
    onPersist: () -> Unit,
    onRemove: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.background)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            AuntieDropdownField(
                value = condition.source,
                options = conditionSourceChoices(condition.source),
                onSelect = { src ->
                    // Re-seeds the attribute key when the new source needs one, so the
                    // rule never points at a field that source cannot read.
                    onChange(changeConditionSource(condition, src))
                    onPersist()
                },
                displayText = { conditionSourceLabel(it) },
                label = "When",
                modifier = Modifier.weight(1f),
            )
            AuntieDropdownField(
                value = condition.op,
                options = conditionOpChoices(condition.op),
                onSelect = {
                    onChange(condition.copy(op = it))
                    onPersist()
                },
                displayText = { conditionOpLabel(it) },
                label = "Is",
                modifier = Modifier.weight(1f),
            )
            AuntieIconBtn(onClick = onRemove) {
                Icon(Lucide.Trash2, contentDescription = "Remove condition", tint = AuntieTheme.colors.error)
            }
        }
        // KIN_ATTRIBUTE and KINFOLK_ATTRIBUTE each draw from their own catalog.
        if (conditionUsesAttributeKey(condition.source)) {
            AuntieDropdownField(
                value = condition.attributeKey,
                options = attributeKeyChoices(condition.source, condition.attributeKey),
                onSelect = {
                    onChange(condition.copy(attributeKey = it))
                    onPersist()
                },
                displayText = { attributeKeyLabel(condition.source, it) },
                label = if (condition.source == ConditionSource.KINFOLK_ATTRIBUTE.name) "Household field" else "Attribute",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (conditionUsesValueInput(condition.op)) {
            val tagOptions = if (conditionUsesTagPicker(condition.source)) {
                tagPickerOptions(householdTags, condition.value)
            } else {
                emptyList()
            }
            when {
                // A tag rule picks from the operator's own vocabulary, so it cannot
                // target a tag no household will ever carry.
                conditionUsesTagPicker(condition.source) && tagOptions.isNotEmpty() -> AuntieDropdownField(
                    value = condition.value.ifBlank { tagOptions.first() },
                    options = tagOptions,
                    onSelect = {
                        onChange(condition.copy(value = it))
                        onPersist()
                    },
                    displayText = { tagOptionLabel(it, householdTags) },
                    label = "Tag",
                    modifier = Modifier.fillMaxWidth(),
                )
                // Empty vocabulary: say so rather than render a picker with nothing in
                // it, and leave the field usable so the rule can still be written.
                conditionUsesTagPicker(condition.source) -> {
                    Text(
                        "No household tags yet. Add them in Settings, or type one below.",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textDim,
                    )
                    AuntieField(
                        value = condition.value,
                        onValueChange = { onChange(condition.copy(value = it)) },
                        label = "Tag",
                        placeholder = conditionValuePlaceholder(condition.source),
                        modifier = Modifier
                            .fillMaxWidth()
                            .onFocusChanged { if (!it.isFocused) onPersist() },
                    )
                }
                else -> AuntieField(
                    value = condition.value,
                    onValueChange = { onChange(condition.copy(value = it)) },
                    label = "Value",
                    placeholder = conditionValuePlaceholder(condition.source),
                    modifier = Modifier
                        .fillMaxWidth()
                        .onFocusChanged { if (!it.isFocused) onPersist() },
                )
            }
        }
        Text(
            conditionSummary(condition),
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.kinfolkOrange,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers behind the condition builder. Extracted from the composables so
// they are unit-testable without a Compose runtime
// ([KinTaleConditionEditorHelpersTest]), and kept byte-for-byte in step with the
// commonMain KinTaleConditionEditorHelpers.kt, which the web and desktop editors
// use. Ported from React's lib/kinTaleTemplateEdit.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The attribute catalog a source's key dropdown draws from: kin attributes for
 * KIN_ATTRIBUTE, household attributes for KINFOLK_ATTRIBUTE, and none for every
 * other source. KINFOLK_TAG is deliberately absent: it matches a tag NAME, not a
 * named field.
 */
internal fun attributeCatalogForSource(source: String): List<ConditionAttribute> = when (source) {
    ConditionSource.KIN_ATTRIBUTE.name     -> conditionAttributeCatalog
    ConditionSource.KINFOLK_ATTRIBUTE.name -> kinfolkAttributeCatalog
    else                                   -> emptyList()
}

/**
 * Switch a condition to a new source, keeping the rule valid by construction. When
 * the new source needs an attribute key and the current key is not in THAT source's
 * catalog (blank, or left over from the other attribute source), it is re-seeded to
 * the catalog's first entry, so the rule can never point at an attribute the engine
 * reads as blank. A source with no catalog leaves the key untouched, matching React.
 */
internal fun changeConditionSource(condition: FieldCondition, source: String): FieldCondition {
    val catalog = attributeCatalogForSource(source)
    if (catalog.isEmpty()) return condition.copy(source = source)
    val valid = catalog.any { it.key == condition.attributeKey }
    return condition.copy(source = source, attributeKey = if (valid) condition.attributeKey else catalog.first().key)
}

/**
 * The source names the "When" picker offers, in catalog order. A [current] value
 * this build does not model is PREPENDED and kept selected rather than snapping the
 * picker to KIN_SPECIES, which would silently rewrite a forward-compatible rule.
 */
internal fun conditionSourceChoices(current: String): List<String> {
    val known = conditionSourceOptions.map { it.source.name }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/** Editor copy for a source name; an unmodelled source is labelled, not hidden. */
internal fun conditionSourceLabel(source: String): String =
    conditionSourceOptions.firstOrNull { it.source.name == source }?.label
        ?: "$source (unrecognised)"

/** The op names the "Is" picker offers, with the same keep-the-unknown rule. */
internal fun conditionOpChoices(current: String): List<String> {
    val known = ConditionOp.values().map { it.name }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/** Editor copy for an op name. */
internal fun conditionOpLabel(op: String): String = when (op) {
    ConditionOp.EQUALS.name     -> "is"
    ConditionOp.NOT_EQUALS.name -> "is not"
    ConditionOp.CONTAINS.name   -> "contains"
    ConditionOp.EXISTS.name     -> "is set"
    else                        -> "$op (unrecognised)"
}

/**
 * The attribute keys the "Attribute" picker offers for [source]. A stored key the
 * catalog does not know is prepended so it stays visible and selected instead of
 * being silently swapped for another field.
 */
internal fun attributeKeyChoices(source: String, current: String): List<String> {
    val known = attributeCatalogForSource(source).map { it.key }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/**
 * Editor copy for an attribute key, looked up in the catalog that owns [source]. A
 * blank key (a legacy rule saved before the editor seeded one) reads as a prompt,
 * not as the first catalog entry: the rule genuinely has no field yet, and showing
 * one would misreport what is stored.
 */
internal fun attributeKeyLabel(source: String, key: String): String = when {
    key.isBlank() -> "Choose a field"
    else -> attributeCatalogForSource(source).firstOrNull { it.key == key }?.label
        ?: "$key (unrecognised)"
}

/** Placeholder for the free-text value input, tuned per source. */
internal fun conditionValuePlaceholder(source: String): String = when (source) {
    ConditionSource.KIN_SPECIES.name  -> "e.g. Cat"
    ConditionSource.SERVICE_TYPE.name -> "e.g. walk"
    ConditionSource.KINFOLK_TAG.name  -> "e.g. VIP"
    else                              -> "Value to match"
}

/** Whether the editor offers the household tag picker instead of the free-text value field. */
internal fun conditionUsesTagPicker(source: String): Boolean =
    source == ConditionSource.KINFOLK_TAG.name

/**
 * The tag names the KINFOLK_TAG picker offers: the household vocabulary in its
 * authored order, blanks dropped, de-duplicated case-INSENSITIVELY (the React tag
 * layer treats "vip" and "VIP" as one tag, so offering both would let the operator
 * pick a duplicate). Names keep the exact casing the vocabulary stores, because that
 * is what a profile assignment stores and what round-trips back to React.
 *
 * A [current] value not in the vocabulary is prepended and stays selected: a tag can
 * be authored on a condition before it is added to the vocabulary, or removed from
 * the vocabulary afterwards, and neither may silently rewrite the rule.
 */
internal fun tagPickerOptions(vocab: List<TagDef>, current: String): List<String> {
    val names = vocab.map { it.name }
        .filter { it.isNotBlank() }
        .distinctBy { it.trim().lowercase() }
    val hasCurrent = names.any { it.trim().equals(current.trim(), ignoreCase = true) }
    return if (current.isNotBlank() && !hasCurrent) listOf(current) + names else names
}

/** Editor copy for one tag option, flagging a name the operator's vocabulary does not carry. */
internal fun tagOptionLabel(name: String, vocab: List<TagDef>): String =
    if (vocab.any { it.name.trim().equals(name.trim(), ignoreCase = true) }) name
    else "$name (not in your tag list)"
