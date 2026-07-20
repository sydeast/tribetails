package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.ProfileTagsSection
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.TagScope

/**
 * B4: read-only view of a Kin (pet).
 *
 * Operator complaint: tapping a Kin card on the kinfolk profile dropped straight
 * into the EDIT form with no way to just VIEW. This is that view: a clean
 * read-only render of the pet's fields with an explicit "Edit" button that routes
 * to [KinEditScreen]. Loads the same way the editor does (kinStream → find by id).
 *
 * The one editable thing here is the Tags panel, matching the React admin. Tags
 * are a labelling gesture, not a form field, so they save the moment you add or
 * remove one rather than waiting for a trip through the editor.
 */
@Composable
fun KinViewScreen(
    kinfolkId: String,
    kinId: String,
    onBack: () -> Unit,
    onEdit: () -> Unit,
) {
    val client = remember { FirestoreClient() }
    val state by remember(kinfolkId) { client.kinStream(kinfolkId) }
        .collectAsState(initial = FirestoreResult.Loading)
    val kin: Kin? = remember(state, kinId) {
        (state as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinId }
    }
    val c = AuntieTheme.colors

    ScreenScaffold {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                GhostButton(label = "Back", onClick = onBack)
                Spacer(Modifier.weight(1f))
                if (kin != null) GhostButton(label = "Edit", onClick = onEdit)
            }

            when {
                state is FirestoreResult.Loading && kin == null -> ShimmerCard(height = 120.dp)
                kin == null -> EmptyHint("This kin couldn't be found. It may have been removed.")
                else -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        AuntieAvatar(
                            imageUrl = kin.profilePictureUrl.ifBlank { null },
                            initials = initialsOf(kin.name),
                            size = 64.dp,
                        )
                        Column {
                            Text(
                                text = kin.name.ifBlank { "Unnamed kin" },
                                style = AuntieTheme.typography.headlineLarge,
                                color = c.textPrimary,
                            )
                            val sub = listOf(kin.species, kin.breed).filter { it.isNotBlank() }.joinToString(" · ")
                            if (sub.isNotBlank()) {
                                Text(sub, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                            }
                        }
                    }

                    // ---- Tags (pet) ----
                    // Names live on this kin doc as a flat `tags` list; the color and
                    // emoji come from the `petTags` vocabulary in business_settings,
                    // resolved at render time. Saving goes through updateKinTags, which
                    // takes the LOADED record so the whole-document write round-trips
                    // every other field instead of wiping it.
                    ProfileTagsSection(
                        scope = TagScope.PET,
                        initialTags = kin.tags,
                        client = client,
                        onSaveTags = { next -> client.updateKinTags(kin, next) },
                    )

                    DenPanel(title = "Basics") {
                        ViewRow("Species", kin.species)
                        ViewRow("Breed", kin.breed)
                        ViewRow("Sex", kin.sex)
                        ViewRow("Age", kin.age)
                        ViewRow("Weight", kin.weight)
                        ViewRow("Color & markings", kin.colorMarkings)
                        ViewRow("Spayed / neutered", if (kin.spayedNeutered) "Yes" else "")
                        ViewRow("Reactive", if (kin.reactive) "Yes" else "")
                        ViewRow("Status", kin.status)
                    }

                    DenPanel(title = "Care") {
                        ViewRow("Stays as", kin.staysAs)
                        ViewRow("Routine", kin.routine)
                        ViewRow("Training & commands", kin.trainingCommands)
                        ViewRow("Feeding", kin.feedingBrand)
                        ViewRow("Vaccinations", kin.vaccinations)
                        ViewRow("Medication & health", kin.medicationHealthNotes)
                        ViewRow("Vet", kin.vetInfo)
                    }

                    if (kin.officeNotes.isNotBlank()) {
                        DenPanel(title = "Internal notes") {
                            Text(kin.officeNotes, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        }
                    }

                    if (kin.ownerEmail.isNotBlank() || kin.ownerPhone.isNotBlank()) {
                        DenPanel(title = "Kin-specific owner contact") {
                            ViewRow("Email", kin.ownerEmail)
                            ViewRow("Phone", kin.ownerPhone, mono = true)
                        }
                    }
                }
            }
        }
    }
}

/** A labelled read-only row, omitted entirely when the value is blank. */
@Composable
private fun ViewRow(label: String, value: String, mono: Boolean = false) {
    if (value.isBlank()) return
    AuntieKeyValueRow(label = label, value = value, valueMono = mono)
}

private fun initialsOf(name: String): String =
    name.trim().split(Regex("\\s+"))
        .mapNotNull { it.firstOrNull()?.uppercaseChar() }
        .take(2)
        .joinToString("")
        .ifBlank { "?" }
