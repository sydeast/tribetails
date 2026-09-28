package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.SECONDARY_KINFOLK_NAME_MAX
import com.tribetails.auntieos.web.data.SecondaryPerson
import com.tribetails.auntieos.web.data.SecondaryPersonDraft
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.personAccessLabel
import com.tribetails.auntieos.web.data.toDraft
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

/**
 * The "Secondary kinfolk" panel body on the desktop household profile
 * (operator rulings 2026-09-27, Q3 and Q4). The desktop console has no members
 * screen, so every person record shows here, an ACTIVE one labelled "Portal
 * access". Add, Edit and Remove go through the callables; there is no invite
 * control, because only the household's primary can invite a secondary
 * kinfolk. Saves are pessimistic and a refusal is shown in the server's words.
 */
@Composable
fun SecondaryKinfolkSection(client: FirestoreClient, kinfolkId: String, householdName: String) {
    val scope = rememberCoroutineScope()
    var generation by remember { mutableIntStateOf(0) }
    var people by remember(kinfolkId) { mutableStateOf<List<SecondaryPerson>?>(null) }
    var loadError by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var draft by remember(kinfolkId) { mutableStateOf<SecondaryPersonDraft?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var removeTarget by remember { mutableStateOf<SecondaryPerson?>(null) }
    var removing by remember { mutableStateOf(false) }
    var removeError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId, generation) {
        when (val r = client.listSecondaryKinfolk(kinfolkId)) {
            is WriteResult.Ok -> { people = r.value; loadError = null }
            is WriteResult.Err -> loadError = "listSecondaryKinfolk failed: ${r.message}"
        }
    }

    SecondaryKinfolkContent(
        people = people,
        loadError = loadError,
        onRetry = { generation++ },
        onAdd = { draft = SecondaryPersonDraft(); saveError = null },
        onEdit = { draft = it.toDraft(); saveError = null },
        onRemove = { removeTarget = it; removeError = null },
    )

    draft?.let { d ->
        SecondaryKinfolkDialog(
            draft = d,
            saving = saving,
            error = saveError,
            onChange = { if (!saving) { draft = it; saveError = null } },
            onCancel = { if (!saving) draft = null },
            onSave = {
                saving = true
                saveError = null
                scope.launch {
                    when (val r = client.saveSecondaryKinfolk(kinfolkId, d)) {
                        is WriteResult.Ok -> { draft = null; generation++ }
                        is WriteResult.Err -> saveError = r.message
                    }
                    saving = false
                }
            },
        )
    }

    removeTarget?.let { target ->
        AuntieDialog(
            visible = true,
            title = "Remove this secondary kinfolk?",
            onDismiss = { if (!removing) removeTarget = null },
            maxWidth = 520.dp,
            footer = {
                GhostButton(label = "Cancel", onClick = { removeTarget = null }, enabled = !removing, modifier = Modifier.weight(1f))
                PrimaryButton(
                    label = if (removing) "Removing…" else "Remove",
                    onClick = {
                        removing = true
                        scope.launch {
                            when (val r = client.removeSecondaryKinfolk(kinfolkId, target.personId)) {
                                is WriteResult.Ok -> { removeTarget = null; generation++ }
                                is WriteResult.Err -> removeError = r.message
                            }
                            removing = false
                        }
                    },
                    enabled = !removing,
                    loading = removing,
                    modifier = Modifier.weight(1f),
                )
            },
        ) {
            Text("${target.name} will be taken off $householdName.", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
            removeError?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) }
        }
    }
}

/** Stateless: the list, its load failure, and Add. Rendered by the tests directly. */
@Composable
fun SecondaryKinfolkContent(
    people: List<SecondaryPerson>?,
    loadError: String?,
    onRetry: () -> Unit,
    onAdd: () -> Unit,
    onEdit: (SecondaryPerson) -> Unit,
    onRemove: (SecondaryPerson) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            // A failed read is never shown as "nobody".
            loadError != null -> {
                Text(loadError, style = AuntieTheme.typography.bodySmall, color = c.error)
                GhostButton(label = "Retry", onClick = onRetry)
            }
            people == null -> Text("Loading secondary kinfolk…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            people.isEmpty() -> Text("No secondary kinfolk on this household yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            else -> people.forEach { p -> SecondaryPersonRow(p, onEdit = { onEdit(p) }, onRemove = { onRemove(p) }) }
        }
        GhostButton(label = "Add secondary kinfolk", onClick = onAdd)
    }
}

@Composable
private fun SecondaryPersonRow(person: SecondaryPerson, onEdit: () -> Unit, onRemove: () -> Unit) {
    val c = AuntieTheme.colors
    val shape = RoundedCornerShape(14.dp)
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.fillMaxWidth().border(1.dp, c.border, shape).padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(person.name, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            AuntieStatusPill(label = personAccessLabel(person.access), tone = AuntieStatusTone.Orange, compact = true)
        }
        val reach = listOfNotNull(person.phone, person.email).joinToString(" · ")
        if (reach.isNotBlank()) Text(reach, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GhostButton(label = "Edit", onClick = onEdit)
            GhostButton(label = "Remove", onClick = onRemove)
        }
    }
}

/**
 * Add or edit. Every field the save sends has a control here, and an edit is
 * seeded from the stored person, so a save rebuilds nothing it cannot show.
 */
@Composable
fun SecondaryKinfolkDialog(
    draft: SecondaryPersonDraft,
    saving: Boolean,
    error: String?,
    onChange: (SecondaryPersonDraft) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    AuntieDialog(
        visible = true,
        title = if (draft.personId == null) "Add secondary kinfolk" else "Edit secondary kinfolk",
        onDismiss = onCancel,
        maxWidth = 520.dp,
        hint = "No invite is sent. Only their primary can give them portal access.",
        footer = {
            GhostButton(label = "Cancel", onClick = onCancel, enabled = !saving, modifier = Modifier.weight(1f))
            PrimaryButton(
                label = if (saving) "Saving…" else "Save",
                onClick = onSave,
                enabled = !saving,
                loading = saving,
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        BottomBorderField(
            draft.name, { onChange(draft.copy(name = it.take(SECONDARY_KINFOLK_NAME_MAX))) },
            label = "Name",
            enabled = !saving,
            required = true,
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            draft.phone, { onChange(draft.copy(phone = it.take(32))) },
            label = "Phone (optional)",
            enabled = !saving,
            modifier = Modifier.fillMaxWidth(),
        )
        BottomBorderField(
            draft.email, { onChange(draft.copy(email = it.take(254))) },
            label = "Email (optional)",
            enabled = !saving,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) }
    }
}
