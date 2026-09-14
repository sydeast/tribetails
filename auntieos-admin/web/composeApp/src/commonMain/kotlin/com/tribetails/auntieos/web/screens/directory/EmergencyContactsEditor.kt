package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_NAME_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_PHONE_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_RELATIONSHIP_MAX
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton

/**
 * Up to two Emergency Contacts, the first called first (#829). Built from the
 * same BottomBorderField and AuntieFieldLabel as the rest of KinfolkEditScreen.
 * [enabled] false (a save in flight) disables every control.
 *
 * #829 review items 4 and 14: the labels are "Name", "Phone" and "Relationship
 * (optional)", as on every client; inputs stop at the server's limits
 * (80/32/40); both slots offer Remove when there are two, the second offers Call
 * first. The who-gets-called tip sits beside the section title, which the screen
 * draws, not on the "Called first" label.
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
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        drafts.forEachIndexed { i, d ->
            AuntieFieldLabel(text = if (i == 0) "Called first" else "Called second")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    d.name, { onChange(i, d.copy(name = it.take(EMERGENCY_CONTACT_NAME_MAX))) },
                    label = "Name",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    d.phone, { onChange(i, d.copy(phone = it.take(EMERGENCY_CONTACT_PHONE_MAX))) },
                    label = "Phone",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(
                    d.relationship, { onChange(i, d.copy(relationship = it.take(EMERGENCY_CONTACT_RELATIONSHIP_MAX))) },
                    label = "Relationship (optional)",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
            }
            if (drafts.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (i > 0) GhostButton(label = "Call first", onClick = { onMoveFirst(i) }, enabled = enabled)
                    GhostButton(label = "Remove", onClick = { onRemove(i) }, enabled = enabled)
                }
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            GhostButton(label = "Add a second Emergency Contact", onClick = onAdd, enabled = enabled)
        }
    }
}
