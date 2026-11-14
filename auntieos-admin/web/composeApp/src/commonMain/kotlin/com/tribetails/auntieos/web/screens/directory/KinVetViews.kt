package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.VetClinic
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface

/** What the household vet line says when the household has none. */
const val NO_HOUSEHOLD_VET = "No household vet on file yet"

/** The label of the legacy free-text vet note, shown only when no clinic resolves. */
const val LEGACY_VET_NOTE_LABEL = "Vet note on file"

/** The household's vet, as the read-only line on Edit kin. */
fun householdVetText(householdVetClinicId: String, clinics: List<VetClinic>): String {
    val id = householdVetClinicId.trim()
    if (id.isEmpty()) return NO_HOUSEHOLD_VET
    val clinic = clinics.firstOrNull { it._id == id } ?: return NO_HOUSEHOLD_VET
    return vetClinicLine(clinic)
}

/**
 * #1908 kin-vet, Edit kin: the household's vet read-only, the "Different vet
 * for this Kin" box, and, when ticked, a dropdown over the whole area vet list.
 */
@Composable
internal fun KinVetEditor(
    legacyNote: String,
    householdVetClinicId: String,
    householdVetLoading: Boolean,
    householdVetError: String?,
    clinicsState: FirestoreResult<List<VetClinic>>,
    allClinics: List<VetClinic>,
    differentVet: Boolean,
    onDifferentVet: (Boolean) -> Unit,
    pickedClinicId: String,
    onPick: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth()) {
        AuntieFieldLabel(text = "Vet")
        Spacer(Modifier.height(4.dp))
        val householdLine = when {
            householdVetLoading || clinicsState is FirestoreResult.Loading -> "Loading the household vet…"
            householdVetError != null -> "Couldn't load the household vet: $householdVetError"
            clinicsState is FirestoreResult.Error -> "Couldn't load the vet list: ${clinicsState.message}"
            else -> householdVetText(householdVetClinicId, allClinics)
        }
        Text(
            text = if (differentVet) "Household vet: $householdLine" else householdLine,
            style = AuntieTheme.typography.bodyMedium,
            color = if (householdLine == NO_HOUSEHOLD_VET) c.textDim else c.textPrimary,
        )
        if (!differentVet && householdVetClinicId.isBlank() && legacyNote.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            AuntieKeyValueRow(label = LEGACY_VET_NOTE_LABEL, value = legacyNote)
        }
        Spacer(Modifier.height(10.dp))
        AuntieCheckbox(checked = differentVet, onCheckedChange = onDifferentVet, label = DIFFERENT_VET_LABEL)
        if (differentVet) {
            Spacer(Modifier.height(10.dp))
            VetClinicPicker(
                label = "Vet for this Kin *",
                clinicsState = clinicsState,
                options = pickableVetClinics(allClinics),
                allClinics = allClinics,
                selectedId = pickedClinicId,
                onPick = onPick,
                allowRemove = false,
            )
            if (pickedClinicId.isBlank()) {
                Spacer(Modifier.height(4.dp))
                Text("Choose a vet, or untick the box.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
    }
}

/** #1908 kin-vet, the Kin view: the vet the Kin goes to, read-only. */
@Composable
internal fun KinVetRows(kin: Kin, householdVetClinicId: String, clinics: List<VetClinic>) {
    val line = resolveKinVet(kin, householdVetClinicId, clinics)
    val clinic = line.clinic
    when {
        clinic != null -> AuntieKeyValueRow(
            label = if (line.fromHousehold) "Vet (household)" else "Vet (this Kin)",
            value = vetClinicLine(clinic),
        )
        line.legacyNote.isNotBlank() -> AuntieKeyValueRow(label = LEGACY_VET_NOTE_LABEL, value = line.legacyNote)
    }
}

/**
 * #1908 kin-vet: the vet dropdown, over [options] (the area list, already
 * filtered to what this slot may pick). It opens listing every option and
 * narrows as the admin types a name or address. [allClinics] resolves the
 * current pick, so a clinic retired since it was linked still shows by name.
 * [busy] shows a save in flight and holds the controls; [error] says why the
 * last one failed.
 */
@Composable
internal fun VetClinicPicker(
    label: String,
    clinicsState: FirestoreResult<List<VetClinic>>,
    options: List<VetClinic>,
    allClinics: List<VetClinic>,
    selectedId: String,
    onPick: (String) -> Unit,
    allowRemove: Boolean,
    busy: Boolean = false,
    error: String? = null,
    emptyText: String = "No vet chosen",
) {
    val c = AuntieTheme.colors
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val current = allClinics.firstOrNull { it._id == selectedId && selectedId.isNotBlank() }
    Column(modifier = Modifier.fillMaxWidth()) {
        AuntieFieldLabel(text = label)
        Spacer(Modifier.height(4.dp))
        Text(
            text = when {
                current != null -> vetClinicLine(current)
                selectedId.isNotBlank() -> "A vet no longer on the list"
                else -> emptyText
            },
            style = AuntieTheme.typography.bodyMedium,
            color = if (current != null) c.textPrimary else c.textDim,
        )
        Spacer(Modifier.height(8.dp))
        when (clinicsState) {
            is FirestoreResult.Loading -> Text("Loading the vet list…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            is FirestoreResult.Error -> Text("Couldn't load the vet list: ${clinicsState.message}", style = AuntieTheme.typography.bodySmall, color = c.error)
            is FirestoreResult.Data -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                GhostButton(
                    label = if (busy) "Saving…" else if (open) "Close list" else if (selectedId.isBlank()) "Choose a vet" else "Change vet",
                    onClick = { open = !open; query = "" },
                    enabled = !busy,
                )
                if (allowRemove && selectedId.isNotBlank()) {
                    GhostButton(label = "Remove vet", onClick = { open = false; onPick("") }, enabled = !busy)
                }
            }
        }
        if (error != null) {
            Spacer(Modifier.height(4.dp))
            Text(error, style = AuntieTheme.typography.bodySmall, color = c.error)
        }
        if (open && clinicsState is FirestoreResult.Data) {
            Spacer(Modifier.height(8.dp))
            BottomBorderField(
                value = query,
                onValueChange = { query = it },
                label = "Search vets",
                placeholder = "Type a name or address",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            val shown = filterVetClinics(options, query)
            GlassSurface(cornerRadius = 14.dp, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
                    if (shown.isEmpty()) {
                        Text(
                            "No vet on the list matches.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    shown.forEach { clinic ->
                        Text(
                            text = vetClinicLine(clinic),
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                            modifier = Modifier.fillMaxWidth()
                                .clickable(enabled = !busy) { open = false; query = ""; onPick(clinic._id) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }
    }
}
