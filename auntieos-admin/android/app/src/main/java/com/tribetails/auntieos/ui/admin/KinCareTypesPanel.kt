package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Trash2
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDashedAddButton
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieSaveBar
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The KinCare types editor, laid out as its mock
 * (`auntieos-admin/ui-ideas/auntieos-kincare-types-2026-05-27.html`, issue
 * #755): a rows panel with a name, duration and rate field per type and a
 * trash button, a dashed "Add KinCare type" that appends a blank row and puts
 * the cursor in its name, a second panel previewing the label the booking
 * wizard's picker renders from these rows, and one save bar under both with
 * the mock's "Unsaved changes" light. The web `KinCareRatesEditor` is the
 * same three pieces in the same order.
 *
 * Saves through [onSettingsChange], which is the ViewModel's diff-and-save:
 * only `serviceRates` and `serviceDurations` reach Firestore, and they reach
 * it as whole maps ([businessSettingsReplacesWholeFields]) so a removed type
 * stays removed. The mock's grip glyph is not drawn: nothing here drags.
 *
 * Every row is a two-line card on a phone, the mock's own narrow layout: name
 * and remove on the first line, duration and rate on the second.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun KinCareTypesPanel(
    settings: BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val baseline = remember(settings) { kinCareRows(settings.serviceRates, settings.serviceDurations) }
    var rows by remember(settings) { mutableStateOf(baseline) }
    var sortKey by remember { mutableStateOf(KinCareSortKey.STORED) }
    // The stored index of a row "Add KinCare type" just appended, so its name
    // field takes focus once it exists. Cleared the moment it has been used.
    var focusPending by remember { mutableStateOf<Int?>(null) }

    val editedRates = foldKinCareRates(rows)
    val editedDurations = foldKinCareDurations(rows)
    val dirty = editedRates != settings.serviceRates || editedDurations != settings.serviceDurations
    val view = sortedKinCareView(rows, sortKey)

    fun updateRow(index: Int, transform: (KinCareTypeRow) -> KinCareTypeRow) {
        rows = rows.mapIndexed { i, row -> if (i == index) transform(row) else row }
    }

    Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
        DenPanel(
            title = "Your KinCare types",
            subtitle = "Add, rename, re-rate, or remove. Most operators go by length of visit (30 min, 60 min, Overnight) but you can name them anything. Saving updates the booking screen for new requests. A greyed duration is what the name implies; it is never saved unless you type it.",
            detail = if (rows.isEmpty()) null else kinCareTypeCount(rows.size),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                if (rows.isEmpty()) {
                    EmptyHint("No KinCare types yet. Add one below.")
                }

                if (rows.size > 1) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("SORT BY", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                        Spacer(Modifier.width(dims.space2))
                        SegmentedPicker(
                            options = KinCareSortKey.entries,
                            selected = sortKey,
                            onSelect = { sortKey = it },
                            label = { it.label },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                // Keyed by STORED index, so a re-sort moves each card with its
                // focus requester instead of leaving the state behind.
                view.forEach { (index, row) -> key(index) {
                    val nameFocus = remember { FocusRequester() }
                    LaunchedEffect(focusPending) {
                        if (focusPending == index) {
                            nameFocus.requestFocus()
                            focusPending = null
                        }
                    }
                    val removeLabel = row.type.trim().let { if (it.isEmpty()) "Remove" else "Remove $it" }
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(c.surface)
                            .border(1.dp, c.borderSoft, RoundedCornerShape(14.dp))
                            .padding(dims.space3),
                        verticalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        Row(
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            AuntieField(
                                value = row.type,
                                onValueChange = { next -> updateRow(index) { it.copy(type = next) } },
                                label = "Type name",
                                placeholder = "e.g. 30 min",
                                enabled = !isLoading,
                                modifier = Modifier.weight(1f),
                                fieldModifier = Modifier.focusRequester(nameFocus),
                            )
                            AuntieIconButton(
                                icon = Lucide.Trash2,
                                contentDescription = removeLabel,
                                onClick = { rows = rows.filterIndexed { i, _ -> i != index } },
                                destructive = true,
                                enabled = !isLoading,
                                size = 34.dp,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
                            AuntieField(
                                value = row.duration,
                                onValueChange = { next -> updateRow(index) { it.copy(duration = next) } },
                                label = "Duration (min)",
                                placeholder = kinCareDurationPlaceholder(row),
                                enabled = !isLoading,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = row.rate,
                                onValueChange = { next -> updateRow(index) { it.copy(rate = next) } },
                                label = "Rate",
                                placeholder = "0.00",
                                enabled = !isLoading,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                } }

                AuntieDashedAddButton(
                    text = "Add KinCare type",
                    onClick = {
                        // A row left blank is dropped by foldKinCareRates, so an
                        // abandoned add never reaches the document and never
                        // makes the bar read dirty.
                        focusPending = rows.size
                        rows = rows + KinCareTypeRow.BLANK
                    },
                    leadingIcon = Lucide.Plus,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        DenPanel(
            title = "How it looks on the booking screen",
            subtitle = "The label the kinfolk and admin see when picking a KinCare type. The first one shows selected for illustration, and the order matches the rows above.",
        ) {
            Column {
                Text("KINCARE TYPE", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                Spacer(Modifier.height(dims.space3))
                if (view.isEmpty()) {
                    EmptyHint("No KinCare types yet. Add one above.")
                } else {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                        verticalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        view.forEachIndexed { position, (_, row) ->
                            // A picture of the picker's row, not the picker: the
                            // chip takes no tap.
                            AuntieChip(
                                selected = position == 0,
                                onClick = {},
                                label = kinCarePreviewLabel(row),
                            )
                        }
                    }
                }
            }
        }

        AuntieSaveBar(
            dirty = dirty,
            saveEnabled = dirty && !isLoading,
            onCancel = { rows = baseline },
            onSave = {
                onSettingsChange(
                    settings.copy(serviceRates = editedRates, serviceDurations = editedDurations),
                )
            },
            saveLabel = "Save KinCare types",
            dirtyLabel = "Unsaved changes",
            savedLabel = "Saved",
        )
    }
}
