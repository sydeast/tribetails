package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.DenInfoTip
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Up to two Emergency Contacts, the first called first. Every field is
 * clearable (#829): a household is allowed to have none on file, and clearing
 * a relationship sends it as blank, never a leftover value.
 *
 * The explanation of who this is for sits behind an info tip on the "Called
 * first" label, never a subtitle under the panel title (rulings 2026-09-11
 * and 2026-09-13).
 */
@Composable
fun EmergencyContactsEditor(
    drafts: List<EmergencyContactDraft>,
    onChange: (Int, EmergencyContactDraft) -> Unit,
    onAdd: () -> Unit,
    onRemove: (Int) -> Unit,
    onMoveFirst: (Int) -> Unit,
    enabled: Boolean = true,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        drafts.forEachIndexed { i, d ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (i == 0) "Called first" else "Called second",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.kinfolkOrange,
                )
                if (i == 0) {
                    DenInfoTip("Called only when no kinfolk can be reached. The first one is called first.")
                }
            }
            AuntieField(
                value = d.name,
                onValueChange = { onChange(i, d.copy(name = it)) },
                label = "Name",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = d.phone,
                onValueChange = { onChange(i, d.copy(phone = it)) },
                label = "Phone",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = d.relationship,
                onValueChange = { onChange(i, d.copy(relationship = it)) },
                label = "Relationship (optional)",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            // The first slot is mandatory: a household clears its fields
            // rather than removing it (`isBlankDrafts` covers "none on
            // file"). Only a second slot, once added, offers both controls.
            if (i > 0) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onMoveFirst(i) }, enabled = enabled) { Text("Call first") }
                    TextButton(onClick = { onRemove(i) }, enabled = enabled) { Text("Remove") }
                }
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            TextButton(onClick = onAdd, enabled = enabled) { Text("Add a second Emergency Contact") }
        }
    }
}
