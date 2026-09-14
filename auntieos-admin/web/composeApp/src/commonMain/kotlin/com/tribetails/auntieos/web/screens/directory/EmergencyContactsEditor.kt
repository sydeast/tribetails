package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_WHO_GETS_CALLED
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieInfoTip
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton

/**
 * Up to two Emergency Contacts, the first called first (#829). Built from the
 * same BottomBorderField and AuntieFieldLabel as the rest of KinfolkEditScreen.
 * The "called only when no kinfolk can be reached" sentence sits behind
 * [AuntieInfoTip] on the first slot label, as admin Android shows it with
 * DenInfoTip. [enabled] false (a save in flight) disables every control.
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                AuntieFieldLabel(text = if (i == 0) "Called first" else "Called second")
                if (i == 0) AuntieInfoTip(EMERGENCY_CONTACT_WHO_GETS_CALLED)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(
                    d.name, { onChange(i, d.copy(name = it)) },
                    label = "Name *",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    d.phone, { onChange(i, d.copy(phone = it)) },
                    label = "Phone *",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(
                    d.relationship, { onChange(i, d.copy(relationship = it)) },
                    label = "Relationship",
                    enabled = enabled,
                    modifier = Modifier.weight(1f),
                )
            }
            if (i > 0 || drafts.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (i > 0) GhostButton(label = "Call first", onClick = { onMoveFirst(i) }, enabled = enabled)
                    if (drafts.size > 1) GhostButton(label = "Remove", onClick = { onRemove(i) }, enabled = enabled)
                }
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            GhostButton(label = "Add a second Emergency Contact", onClick = onAdd, enabled = enabled)
        }
    }
}
