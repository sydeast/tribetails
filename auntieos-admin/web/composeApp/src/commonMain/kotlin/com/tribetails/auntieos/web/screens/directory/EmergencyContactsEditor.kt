package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_OVER_LIMIT
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_NAME_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_PHONE_MAX
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACT_RELATIONSHIP_MAX
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * The household's Emergency Contact (#829). One per household (operator ruling
 * 2026-09-27, Q2): there is no way to add a second. A household that still has
 * two on file from the earlier rule shows both, each with Remove, under
 * [EMERGENCY_CONTACTS_OVER_LIMIT]. Built from the
 * same BottomBorderField and AuntieFieldLabel as the rest of KinfolkEditScreen.
 * [enabled] false (a save in flight) disables every control.
 *
 * #829 review items 4 and 14: the labels are "Name", "Phone" and "Relationship
 * (optional)", as on every client; inputs stop at the server's limits
 * (80/32/40). The who-gets-called tip sits beside the section title, which the
 * screen draws.
 */
@Composable
fun EmergencyContactsEditor(
    drafts: List<EmergencyContactDraft>,
    onChange: (Int, EmergencyContactDraft) -> Unit,
    onRemove: (Int) -> Unit,
    enabled: Boolean = true,
) {
    val overLimit = drafts.size > EMERGENCY_CONTACTS_MAX
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (overLimit) {
            Text(EMERGENCY_CONTACTS_OVER_LIMIT, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.warning)
        }
        drafts.forEachIndexed { i, d ->
            if (overLimit) AuntieFieldLabel(text = "On file ${i + 1}")
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
            if (overLimit) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(label = "Remove", onClick = { onRemove(i) }, enabled = enabled)
                }
            }
        }
    }
}
