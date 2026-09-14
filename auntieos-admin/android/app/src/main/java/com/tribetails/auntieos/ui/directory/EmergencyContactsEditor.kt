package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_NAME_MAX
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_PHONE_MAX
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_RELATIONSHIP_MAX
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenInfoTip
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The Emergency Contacts card on Add and Edit Kinfolk (#829 review items 10 and
 * 14): the title "Emergency Contacts" with the who-gets-called sentence behind
 * [DenInfoTip] beside it (a tap opens it), the compact "No Emergency Contact"
 * flag when the household has none on file, an "Unsaved changes" line, the
 * editor, and a contact refusal under it. The same card on both screens, so they
 * cannot drift apart again.
 */
@Composable
fun EmergencyContactsSection(
    drafts: List<EmergencyContactDraft>,
    onChange: (Int, EmergencyContactDraft) -> Unit,
    onAdd: () -> Unit,
    onRemove: (Int) -> Unit,
    onMoveFirst: (Int) -> Unit,
    enabled: Boolean = true,
    showNoneOnFile: Boolean = false,
    unsaved: Boolean = false,
    error: String? = null,
) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Emergency Contacts",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.kinfolkOrange,
                )
                DenInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED)
            }
            if (showNoneOnFile) {
                AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange, compact = true)
            }
            EmergencyContactsEditor(drafts, onChange, onAdd, onRemove, onMoveFirst, enabled)
            if (unsaved) {
                Text("Unsaved changes", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            }
            error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) }
        }
    }
}

/**
 * Up to two Emergency Contacts, the first called first. Every field is
 * clearable (#829): a household is allowed to have none on file, and clearing
 * a relationship sends it as blank, never a leftover value.
 *
 * #829 review: inputs stop at the server's limits (80/32/40). With two
 * contacts, both slots offer Remove and the second offers Call first.
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
            Text(
                if (i == 0) "Called first" else "Called second",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange,
            )
            AuntieField(
                value = d.name,
                onValueChange = { onChange(i, d.copy(name = it.take(EMERGENCY_CONTACT_NAME_MAX))) },
                label = "Name",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = d.phone,
                onValueChange = { onChange(i, d.copy(phone = it.take(EMERGENCY_CONTACT_PHONE_MAX))) },
                label = "Phone",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = d.relationship,
                onValueChange = { onChange(i, d.copy(relationship = it.take(EMERGENCY_CONTACT_RELATIONSHIP_MAX))) },
                label = "Relationship (optional)",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            if (drafts.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (i > 0) TextButton(onClick = { onMoveFirst(i) }, enabled = enabled) { Text("Call first") }
                    TextButton(onClick = { onRemove(i) }, enabled = enabled) { Text("Remove") }
                }
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            TextButton(onClick = onAdd, enabled = enabled) { Text("Add a second Emergency Contact") }
        }
    }
}
