package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDatePickerDialog
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate

private val HHMM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/**
 * B6: admin blocks an unavailable window (operator replaced the Schedule "New
 * Visit" create with this). Date is picked via the wasm-safe [AuntieDatePickerDialog];
 * start/end are HH:mm; the write goes through the admin-gated createBlockedTimeSlot
 * callable and the grid re-renders the new BLOCKED slot as a "Busy" overlay. Fails
 * loud: a write error surfaces in a banner instead of silently closing.
 */
@Composable
fun BlockTimeDialog(
    client: FirestoreClient,
    today: LocalDate,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()

    var date by remember { mutableStateOf<LocalDate?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var startTime by remember { mutableStateOf("") }
    var endTime by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val startOk = HHMM.matches(startTime.trim())
    val endOk = HHMM.matches(endTime.trim())
    val canSave = date != null && startOk && endOk && startTime.trim() < endTime.trim() && !saving

    AuntieDialog(
        visible = true,
        title = "Block time",
        hint = "Mark a window unavailable so kinfolk can't book it.",
        onDismiss = onDismiss,
        maxWidth = 420.dp,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(
                label = if (saving) "Blocking…" else "Block time",
                enabled = canSave,
                onClick = {
                    date?.let { d ->
                        saving = true
                        error = null
                        scope.launch {
                            when (val r = client.createBlockedTimeSlot(
                                d.toString(), startTime.trim(), endTime.trim(), notes.trim(),
                            )) {
                                is WriteResult.Ok  -> { saving = false; onCreated() }
                                is WriteResult.Err -> { error = r.message; saving = false }
                            }
                        }
                    }
                },
            )
        },
    ) {
        Text("DATE", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(8.dp))
                .clickable { showDatePicker = true }
                .padding(horizontal = 12.dp, vertical = 12.dp),
        ) {
            Text(
                text = date?.toString() ?: "Pick a date",
                style = AuntieTheme.typography.bodyMedium,
                color = if (date == null) c.textDim else c.textPrimary,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BottomBorderField(
                value = startTime, onValueChange = { startTime = it },
                label = "Start (HH:MM)", placeholder = "09:00",
                keyboardType = KeyboardType.Number, modifier = Modifier.weight(1f),
            )
            BottomBorderField(
                value = endTime, onValueChange = { endTime = it },
                label = "End (HH:MM)", placeholder = "12:00",
                keyboardType = KeyboardType.Number, modifier = Modifier.weight(1f),
            )
        }

        MultilineField(
            value = notes, onValueChange = { notes = it },
            label = "Reason (optional)", placeholder = "e.g. Vacation, appointment",
            minLines = 2, modifier = Modifier.fillMaxWidth(),
        )

        error?.let { msg ->
            Spacer(Modifier.height(4.dp))
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't block the time") {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
    }

    AuntieDatePickerDialog(
        visible = showDatePicker,
        selectedDate = date,
        today = today,
        onPick = { date = it; showDatePicker = false },
        onDismiss = { showDatePicker = false },
    )
}
