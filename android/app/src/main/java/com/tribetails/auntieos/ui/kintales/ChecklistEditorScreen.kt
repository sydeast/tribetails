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
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.ConditionOp
import com.tribetails.auntieos.data.model.ConditionSource
import com.tribetails.auntieos.data.model.FieldCondition
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

    val perPet = state.template.checklistItems
        .filter { it.scope == ChecklistScope.PER_PET.name }
        .sortedBy { it.order }
    val perVisit = state.template.checklistItems
        .filter { it.scope == ChecklistScope.PER_VISIT.name }
        .sortedBy { it.order }

    AuntieScreenScaffold(
        title = "Configure Checklist",
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
                            leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(18.dp)) }
                        )
                    }

                    ChecklistGroup(
                        heading = "Per Pet Items",
                        count = perPet.size,
                        helperText = "These items will appear once for each pet in the service",
                        icon = Lucide.User,
                        items = perPet,
                        bankAvailable = bankItemsNotInChecklist(bank, state.template.checklistItems)
                            .filter { it.scope == ChecklistScope.PER_PET.name },
                        onUpdate = viewModel::updateChecklistItem,
                        onDelete = { viewModel.removeChecklistItem(it); viewModel.persist() },
                        onPersist = viewModel::persist,
                        onAdd = { viewModel.addChecklistItem(ChecklistScope.PER_PET) },
                        onAddFromBank = { viewModel.addFromBank(it); viewModel.persist() },
                        onSaveToBank = { viewModel.saveItemToBank(it.text, it.scope) },
                    )

                    ChecklistGroup(
                        heading = "Per Visit Items",
                        count = perVisit.size,
                        helperText = "These items will appear once per visit, regardless of how many pets are in the service",
                        icon = Lucide.ListPlus,
                        items = perVisit,
                        bankAvailable = bankItemsNotInChecklist(bank, state.template.checklistItems)
                            .filter { it.scope == ChecklistScope.PER_VISIT.name },
                        onUpdate = viewModel::updateChecklistItem,
                        onDelete = { viewModel.removeChecklistItem(it); viewModel.persist() },
                        onPersist = viewModel::persist,
                        onAdd = { viewModel.addChecklistItem(ChecklistScope.PER_VISIT) },
                        onAddFromBank = { viewModel.addFromBank(it); viewModel.persist() },
                        onSaveToBank = { viewModel.saveItemToBank(it.text, it.scope) },
                    )
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
private fun ChecklistGroup(
    heading: String,
    count: Int,
    helperText: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    items: List<ChecklistItem>,
    bankAvailable: List<com.tribetails.auntieos.data.model.ChecklistBankItem>,
    onUpdate: (ChecklistItem) -> Unit,
    onDelete: (key: String) -> Unit,
    onPersist: () -> Unit,
    onAdd: () -> Unit,
    onAddFromBank: (com.tribetails.auntieos.data.model.ChecklistBankItem) -> Unit,
    onSaveToBank: (ChecklistItem) -> Unit,
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
                )
            }
        }

        AuntieTextBtn(onClick = onAdd) {
            Icon(Lucide.Plus, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
            Spacer(Modifier.width(6.dp))
            Text("Add ${heading.lowercase().removeSuffix(" items")}", color = AuntieTheme.colors.kinfolkOrange)
        }

        // Run-4 #7b: "Add from bank" of common items not already in this group.
        if (bankAvailable.isNotEmpty()) {
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
private fun ChecklistItemEditor(
    item: ChecklistItem,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onUpdate: (ChecklistItem) -> Unit,
    onDelete: (key: String) -> Unit,
    onPersist: () -> Unit,
    onSaveToBank: (ChecklistItem) -> Unit,
) {
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
                    AuntieField(
                        value = item.text,
                        onValueChange = { onUpdate(item.copy(text = it)) },
                        label = "Item Text",
                        modifier = Modifier
                            .weight(1f)
                            .onFocusChanged { if (!it.isFocused) onPersist() },
                    )
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

                ChecklistConditionsEditor(item = item, onUpdate = onUpdate, onPersist = onPersist)
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
                "Always shown. Add a condition to show this item only for certain pets or services.",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
        } else {
            item.conditions.forEachIndexed { idx, cond ->
                ConditionRow(
                    condition = cond,
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

@Composable
private fun ConditionRow(
    condition: FieldCondition,
    onChange: (FieldCondition) -> Unit,
    onPersist: () -> Unit,
    onRemove: () -> Unit,
) {
    val sources = ConditionSource.values().toList()
    val ops = ConditionOp.values().toList()
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
                value = sources.firstOrNull { it.name == condition.source },
                options = sources,
                onSelect = { src ->
                    val attr = if (src == ConditionSource.KIN_ATTRIBUTE && condition.attributeKey.isBlank())
                        conditionAttributeCatalog.first().key else condition.attributeKey
                    onChange(condition.copy(source = src.name, attributeKey = attr))
                    onPersist()
                },
                displayText = { conditionSourceLabel(it) },
                label = "When",
                modifier = Modifier.weight(1f),
            )
            AuntieDropdownField(
                value = ops.firstOrNull { it.name == condition.op },
                options = ops,
                onSelect = {
                    onChange(condition.copy(op = it.name))
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
        if (conditionUsesAttributeKey(condition.source)) {
            AuntieDropdownField(
                value = conditionAttributeCatalog.firstOrNull { it.key == condition.attributeKey },
                options = conditionAttributeCatalog,
                onSelect = {
                    onChange(condition.copy(attributeKey = it.key))
                    onPersist()
                },
                displayText = { it.label },
                label = "Attribute",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (conditionUsesValueInput(condition.op)) {
            AuntieField(
                value = condition.value,
                onValueChange = { onChange(condition.copy(value = it)) },
                label = "Value",
                placeholder = conditionValuePlaceholder(condition.source),
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { if (!it.isFocused) onPersist() },
            )
        }
        Text(
            conditionSummary(condition),
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.kinfolkOrange,
        )
    }
}

private fun conditionSourceLabel(s: ConditionSource): String = when (s) {
    ConditionSource.KIN_SPECIES -> "Pet species"
    ConditionSource.KIN_ATTRIBUTE -> "Pet attribute"
    ConditionSource.SERVICE_TYPE -> "Service type"
}

private fun conditionOpLabel(o: ConditionOp): String = when (o) {
    ConditionOp.EQUALS -> "is"
    ConditionOp.NOT_EQUALS -> "is not"
    ConditionOp.CONTAINS -> "contains"
    ConditionOp.EXISTS -> "is set"
}

private fun conditionValuePlaceholder(source: String): String = when (source) {
    ConditionSource.KIN_SPECIES.name -> "e.g. Cat"
    ConditionSource.SERVICE_TYPE.name -> "e.g. walk"
    else -> "Value to match"
}
