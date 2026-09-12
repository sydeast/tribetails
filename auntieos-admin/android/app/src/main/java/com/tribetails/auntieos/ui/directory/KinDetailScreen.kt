package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.domain.UPCOMING_HORIZON_DAYS
import com.tribetails.auntieos.domain.feedCountMeta
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.DynamicFormFieldsReadOnly
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.ui.components.LoadingScreen
import com.tribetails.auntieos.ui.components.ProfileTagsSection
import com.tribetails.auntieos.ui.components.hasDynamicFieldValues
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The hero line under the pet's name: "Labrador Retriever · 5 yrs · neutered
 * male · 68 lbs", the mock's own. Breed leads and species stands in only when no
 * breed is on file; blanks drop out rather than leaving a dangling dot. Colour
 * and markings ride at the end, since the mock has no other home for them and
 * they are identity in the same way the breed is.
 *
 * Kept branch for branch with `kinHeroLine` in `src/screens/KinView.tsx`.
 */
internal fun kinHeroLine(k: Kin): String = listOf(
    k.breed.trim().ifBlank { k.species },
    k.age.trim().takeIf { it.isNotBlank() }?.let { "$it yrs" }.orEmpty(),
    sexLine(k.sex, k.spayedNeutered),
    k.weight,
    k.colorMarkings,
).map { it.trim() }.filter { it.isNotBlank() }.joinToString(" · ")

/**
 * "neutered male" / "spayed female" the way the mock says it, from the free-text
 * `sex` and the `spayedNeutered` flag. A sex those two words do not fit keeps
 * its own wording and takes the flag after it.
 */
internal fun sexLine(sex: String, spayedNeutered: Boolean): String {
    val s = sex.trim()
    if (!spayedNeutered) return s
    val lower = s.lowercase()
    return when {
        lower.startsWith("f") -> "spayed female"
        lower.startsWith("m") -> "neutered male"
        s.isBlank() -> "spayed / neutered"
        else -> "$s · spayed / neutered"
    }
}

/** The legacy free-text checklist, one row per line, blank lines dropped. */
internal fun checklistLines(checklist: String): List<String> =
    checklist.split("\r\n", "\n").map { it.trim() }.filter { it.isNotBlank() }

/** True when any of [values] carries something to show. */
private fun any(vararg values: String): Boolean = values.any { it.isNotBlank() }

/**
 * Kin (pet) detail: the screen `ui-ideas/auntieos-kin-detail-2026-05-27.html`
 * draws, and the Android half of `src/screens/KinView.tsx`.
 *
 * The web has had this as its own screen since the port; Android had the pet as
 * a card inside the household profile whose only tap was into the editor, so the
 * one place a pet is described in full did not exist on the phone. It does now,
 * with its own route, and the household profile's Kin card is its entry point
 * rather than being removed: the card is the mock's own `.pet` row and carries
 * the three 411 facts the profile has always shown.
 *
 * ONE COLUMN, in the order the web reads its two: the hero, then what a visit
 * needs to know (care, medical, notes), then what Auntie knows and what is
 * coming (the 411, the pet's KinTales, upcoming KinCare). Every panel renders
 * with a quiet empty line when there is nothing on file, so the page has the
 * same shape for every pet.
 *
 * ADMIN-ONLY SURFACE. The 411 panel is on it for the same reason the household
 * profile's dossier band is on that one: 411s and dossiers never reach a
 * kinfolk-facing screen, and this app is the operator's.
 *
 * Rulings this screen carries: tags are pills beside the name (#686); no
 * explanatory copy under the title (#758); a REACTIVE pet gets a warning pill
 * under the identity band rather than a page banner (#690); there is no "New
 * KinTale" action, since a KinTale is only ever started from a KinCare (#676).
 */
@Composable
fun KinDetailScreen(
    kinId: String,
    viewModel: KinDetailViewModel = viewModel(),
    onBack: () -> Unit,
    onDirectory: () -> Unit = onBack,
    onHousehold: (kinfolkId: String) -> Unit = {},
    onEditKin: (kinId: String) -> Unit = {},
    onOpenReport: (sessionId: String) -> Unit = {},
    onOpenVisit: (sessionId: String) -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    var tagsOpen by remember { mutableStateOf(false) }

    // RE-READ ON RETURN, not only on first composition. "Edit kin" is a separate
    // route, so a save pops back to a screen whose `LaunchedEffect(kinId)` will
    // not fire again and which would go on showing the pre-save record. The
    // observer form is this app's own (LiveTrackingScreen, KinCareRouteMap,
    // RouteViewerScreen all use it) rather than a new dependency.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, kinId) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.load(kinId)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val kin = state.kin
    AuntieScreenScaffold(title = kin?.name ?: "Kin", onBack = onBack) {
        when {
            state.isLoading -> LoadingScreen(message = "Loading kin…", modifier = Modifier.fillMaxSize())

            kin == null -> androidx.compose.foundation.layout.Box(
                Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(state.error ?: "Kin not found", color = AuntieTheme.colors.error)
            }

            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = PaddingValues(bottom = 80.dp),
            ) {
                item {
                    KinHero(
                        kin = kin,
                        householdName = state.householdName,
                        householdId = state.householdId,
                        tagsOpen = tagsOpen,
                        onToggleTags = { tagsOpen = !tagsOpen },
                        onDirectory = onDirectory,
                        onHousehold = onHousehold,
                        onEdit = { onEditKin(kin.id) },
                    )
                }

                // #690: a marker UNDER the band, not a page banner and not a
                // pill in the band's tag row. The operator asked for it under
                // the box rather than among the tags, and that ruling outranks
                // the mock's own `.tag.alert`.
                if (kin.reactive) {
                    item {
                        AuntieStatusPill(
                            label = "Reactive: handle with care",
                            tone = AuntieStatusTone.Warning,
                            mono = true,
                        )
                    }
                }

                if (tagsOpen) {
                    item {
                        key(kin.id) {
                            val repository = remember { AuntieOSApp.instance.repository }
                            ProfileTagsSection(
                                scope = TagScope.PET,
                                initialTags = kin.tagNames(),
                                // TAGS ONLY, one field. See KinDetailViewModel.saveTags.
                                onSaveTags = { next -> viewModel.saveTags(kin.id, kin.kinfolkId, next) },
                                loadVocab = { loadTagVocab(repository, TagScope.PET) },
                                onSaveVocab = { defs -> saveTagVocab(repository, TagScope.PET, defs) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                item { CareChecklistPanel(kin, state) }
                item { MedicalPanel(kin) }
                item { AuntieNotesOnKinPanel(kin) }
                item { The411Panel(kin, state) }

                if (state.householdId.isBlank()) {
                    // A pet with no household on file has no feed to narrow:
                    // KinTales and visits are booked against a household. Said,
                    // rather than two panels quietly reading as "none".
                    item {
                        DenPanel(title = "${kin.name}'s KinTales") {
                            EmptyHint(
                                "No household on file for ${kin.name}, so no KinTales or visits can be matched.",
                            )
                        }
                    }
                } else {
                    item { KinTalesPanel(kin, state, onOpenReport) }
                    item { UpcomingKinCarePanel(kin, state, onOpenVisit) }
                }
            }
        }
    }
}

/**
 * The mock's hero: the trail, the pet's identity, the `.tags` row, and the
 * actions that act on the pet.
 *
 * It IS the kit's `DenScreenHeading`, band and all: the trail and the title are
 * its own, the photo rides `leading`, the facts line its `detail`, the status
 * and tags its `badges`, "Edit kin" its `trailing`, and the "belongs to" line
 * its `content`. Nothing here paints a hero of its own.
 */
@Composable
private fun KinHero(
    kin: Kin,
    householdName: String,
    householdId: String,
    tagsOpen: Boolean,
    onToggleTags: () -> Unit,
    onDirectory: () -> Unit,
    onHousehold: (String) -> Unit,
    onEdit: () -> Unit,
) {
    val c = AuntieTheme.colors
    val heroLine = kinHeroLine(kin)
    val status = kin.status.trim().lowercase()
    // The household step is DROPPED rather than filled with a guess when the
    // owning household could not be resolved, the same rule the React twin's
    // `householdCrumb` follows.
    val crumbs = buildList {
        add(DenCrumb("Directory", onDirectory))
        if (householdName.isNotBlank() && householdId.isNotBlank()) {
            add(DenCrumb(householdName) { onHousehold(householdId) })
        }
        add(DenCrumb(kin.name.ifBlank { kin.id }))
    }
    DenScreenHeading(
        kicker = "The Den · Directory",
        crumbs = crumbs,
        title = kin.name.ifBlank { kin.id },
        detail = heroLine.ifBlank { null },
        modifier = Modifier.fillMaxWidth(),
        leading = {
            AuntieAvatar(
                imageUrl = kin.profilePictureUrl,
                initials = kin.name.take(1).uppercase().ifBlank { "?" },
                size = 84.dp,
                shape = RoundedCornerShape(24.dp),
                gradientSeed = kin.id.ifBlank { kin.name },
            )
        },
        badges = {
            // The mock draws no status on a pet, because the pet it draws is
            // active. One that is not must still say so.
            if (status.isNotBlank() && status != "active") {
                AuntieStatusPill(label = status, tone = AuntieStatusTone.Neutral, mono = true)
            }
            kin.tagNames().forEach { tag ->
                AuntieStatusPill(label = tag, tone = AuntieStatusTone.Teal, mono = true)
            }
            GhostButton(label = if (tagsOpen) "Done" else "Edit tags", onClick = onToggleTags)
        },
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GhostButton(label = "Edit kin", onClick = onEdit)
            }
        },
        content = {
            if (householdName.isNotBlank() && householdId.isNotBlank()) {
                Text(
                    text = "belongs to $householdName",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
    )
}

/**
 * What a visit needs to know, which is what "Care checklist" means on a pet.
 *
 * The mock's checklist is the per-visit ChecklistItem template. The pet doc
 * holds the admin's own care instructions (stays as, routine, training, food),
 * the structured KIN form_schemas answers Android authors on the Edit screen,
 * and a legacy free-text checklist that is read-only on both platforms.
 */
@Composable
private fun CareChecklistPanel(kin: Kin, state: KinDetailUiState) {
    val lines = checklistLines(kin.checklist)
    val hasCare = any(kin.staysAs, kin.routine, kin.trainingCommands, kin.feedingBrand)
    val hasStructured = hasDynamicFieldValues(state.kinSchemas, kin.formValues)
    DenPanel(title = "Care checklist", meta = "per visit") {
        Column {
            if (hasCare) {
                FieldRows(
                    Field("Stays as", kin.staysAs),
                    Field("Routine", kin.routine),
                    Field("Training / commands", kin.trainingCommands),
                    Field("Food / brand", kin.feedingBrand),
                )
            }
            if (hasStructured) {
                DynamicFormFieldsReadOnly(state.kinSchemas, kin.formValues) { label, value ->
                    AuntieKeyValueRow(label = label, value = value)
                }
            } else if (state.schemaError != null && kin.formValues.isNotEmpty()) {
                // Fail loud: saved checklist answers exist but their labels could not load.
                EmptyHint("Couldn't load the care-checklist field labels. ${state.schemaError}", error = true)
            }
            lines.forEach { line ->
                Text(
                    text = "· $line",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                    modifier = Modifier.padding(vertical = 3.dp),
                )
            }
            if (!hasCare && !hasStructured && lines.isEmpty()) {
                EmptyHint("No care notes for ${kin.name} yet.")
            }
        }
    }
}

/**
 * Vaccinations, medication and the legacy vet line.
 *
 * `vetInfo` is READ-ONLY here and authored nowhere on the pet: the canonical vet
 * is the household's (`household_data.primaryVetClinicId`, operator ruling
 * 2026-08-01). Legacy pet docs still carry real text in this field, so it is
 * shown and never written, exactly as the React twin's Medical panel does.
 */
@Composable
private fun MedicalPanel(kin: Kin) {
    DenPanel(title = "Medical", meta = "${kin.name} only") {
        if (any(kin.vaccinations, kin.medicationHealthNotes, kin.vetInfo)) {
            FieldRows(
                Field("Vaccinations", kin.vaccinations),
                Field("Medication / health notes", kin.medicationHealthNotes),
                Field("Vet info", kin.vetInfo),
            )
        } else {
            EmptyHint("No medical notes for ${kin.name} yet.")
        }
    }
}

/** The pet's office notes. Admin-only, on an admin surface. */
@Composable
private fun AuntieNotesOnKinPanel(kin: Kin) {
    DenPanel(title = "Auntie's notes", meta = "admin only") {
        if (kin.officeNotes.isNotBlank()) {
            Text(
                text = kin.officeNotes,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textPrimary,
            )
        } else {
            EmptyHint("No notes yet.")
        }
    }
}

/**
 * The pet's 411: what the reconcile pipeline has worked out about it from the
 * household's comms history.
 *
 * ADMIN-ONLY. A 411 is never shown to a kinfolk on any surface, and this screen
 * is the operator's.
 */
@Composable
private fun The411Panel(kin: Kin, state: KinDetailUiState) {
    val f = state.kin411
    DenPanel(title = "The 411", meta = "auto-generated") {
        Column {
            when {
                state.kin411Error != null ->
                    EmptyHint("Couldn't load ${kin.name}'s 411. ${state.kin411Error}", error = true)

                f == null || !any(
                    f.tldr,
                    f.personality,
                    f.quirksAndPreferences,
                    f.dietaryDetails,
                    f.medicalNotes,
                ) -> EmptyHint("No 411 for ${kin.name} yet.")

                else -> FieldRows(
                    Field("In short", stripDossierSources(f.tldr)),
                    Field("Personality", stripDossierSources(f.personality)),
                    Field("Quirks and preferences", stripDossierSources(f.quirksAndPreferences)),
                    Field("Diet", stripDossierSources(f.dietaryDetails)),
                    Field("Medical notes", stripDossierSources(f.medicalNotes)),
                )
            }
        }
    }
}

/** SENT KinTales that cover this pet, newest first. A row opens its report. */
@Composable
private fun KinTalesPanel(kin: Kin, state: KinDetailUiState, onOpenReport: (String) -> Unit) {
    DenPanel(
        title = "${kin.name}'s KinTales",
        meta = feedCountMeta(state.tales.size, state.taleCount, capped = false),
    ) {
        when {
            state.talesError != null ->
                EmptyHint("Couldn't load ${kin.name}'s KinTales. ${state.talesError}", error = true)

            state.tales.isEmpty() -> EmptyHint("No KinTales about ${kin.name} yet.")

            else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.tales.forEach { report ->
                    TaleTile(
                        report = report,
                        onOpen = report.sessionId.takeIf { it.isNotBlank() }?.let { id -> { onOpenReport(id) } },
                    )
                }
            }
        }
    }
}

/** This pet's next visits, inside the mock's own "next 7 days" window. */
@Composable
private fun UpcomingKinCarePanel(kin: Kin, state: KinDetailUiState, onOpenVisit: (String) -> Unit) {
    DenPanel(title = "Upcoming KinCare", meta = "next $UPCOMING_HORIZON_DAYS days") {
        when {
            state.visitsError != null ->
                EmptyHint("Couldn't load ${kin.name}'s visits. ${state.visitsError}", error = true)

            state.upcomingVisits.isEmpty() ->
                EmptyHint("No visits booked for ${kin.name} in the next $UPCOMING_HORIZON_DAYS days.")

            else -> Column {
                state.upcomingVisits.forEachIndexed { index, session ->
                    VisitLine(
                        s = session,
                        last = index == state.upcomingVisits.lastIndex,
                        onOpen = session.id.takeIf { it.isNotBlank() }?.let { id -> { onOpenVisit(id) } },
                    )
                }
            }
        }
    }
}
