package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.BookOpen
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.data.model.TrainingDocument
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDashedAddButton
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ── feature flag ─────────────────────────────────────────────────────────────
// auntieos.trainingDocs.create, read via the ambient LocalFeatureFlags (central
// registry, ALWAYS_ON). Gates the "Add intel" trigger + Add/Edit form + the
// per-row Edit/Delete controls. LIVE (spec 23): backed by the
// createTrainingDocument / updateTrainingDocument / deleteTrainingDocument admin
// callables, with attachments via the TRIBAL_INTEL media pipeline and a real
// Kinfolk/Kin target picker. The web Tribal Intel screen has the same
// create/edit/delete surface (auntieos-admin/src/screens/TribalIntel.tsx +
// components/TribalIntelForm.tsx).

/**
 * Pure client-side comm-type narrowing: when a comm type is selected, keep only
 * docs with that exact communicationType; a null selection is a no-op. In-memory
 * only on the loaded list. Mirrors the web TrainingDocumentsScreen filter.
 * Unit-tested.
 */
internal fun trainingDocsCommTypeFilter(
    docs: List<TrainingDocument>,
    selected: String?,
): List<TrainingDocument> =
    if (selected == null) docs else docs.filter { it.communicationType == selected }

/**
 * Drops content-less junk rows: leftover all-null import/seed documents with
 * nothing in them, which would otherwise render as "Untitled Document" with a
 * blank body and inflate the summary counts.
 *
 * Extracted so the SUMMARY and the LIST run the same filter. They did not: the
 * list filtered inline while `SummaryRow(trainingDocs)` counted the raw loaded
 * set, so Total could claim more documents than the screen showed.
 *
 * An attachment-only row is KEPT. The archive rule was title-or-content, written
 * before attachments existed on the model; the deployed callable now accepts
 * "title OR content OR at least one attachment", so a photo-only entry is a
 * legitimately saved one and hiding it would lose the operator's own note. Same
 * rule as the web `dropEmptyTribalIntel`.
 */
internal fun dropEmptyTrainingDocs(docs: List<TrainingDocument>): List<TrainingDocument> =
    docs.filter { it.title.isNotBlank() || it.content.isNotBlank() || it.attachments.isNotEmpty() }

@Composable
fun TrainingDocumentsScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val loadedDocs by viewModel.trainingDocuments.collectAsState()
    // Junk rows dropped ONCE, here, so the summary counts and the list can never
    // describe different sets (they did: the list filtered, the summary did not).
    val trainingDocs = remember(loadedDocs) { dropEmptyTrainingDocs(loadedDocs) }
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    val queuedMessage by viewModel.trainingDocQueuedMessage.collectAsState()
    val c = AuntieTheme.colors
    val flags = LocalFeatureFlags.current

    var searchQuery by remember { mutableStateOf("") }
    // Add/Edit form visibility. Gated behind flags.trainingDocsCreate.
    var showAddForm by remember { mutableStateOf(false) }
    // The doc currently being edited (null = creating a new entry).
    var editingDoc by remember { mutableStateOf<TrainingDocument?>(null) }
    // Local Comm. Type chip selection (always on). Single-select, in-memory only.
    var commTypeFilter by remember { mutableStateOf<String?>(null) }

    // Both rosters, so a row can name the household, the kinfolk, or the kin it
    // points at instead of printing a raw document id.
    val kinfolkDirectory by viewModel.kinfolkDirectory.collectAsState()
    val kinDirectory by viewModel.kinDirectory.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.loadTrainingDocuments()
        viewModel.loadKinfolkDirectory()
        viewModel.loadKinDirectory()
    }

    AuntieScreenScaffold(
        title = "Tribal Intel",
        onBack = onBack,
    ) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh = { viewModel.loadTrainingDocuments() },
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = AuntieTheme.dims.space4),
                verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space4),
                contentPadding = PaddingValues(vertical = AuntieTheme.dims.space4),
            ) {
                item {
                    DenScreenHeading(
                        // Renamed "Tribal Intel" (LOCKED Decision 3). TODO(auntie copy):
                        // final subtitle wording is author-owned; the name is decided.
                        kicker = "The Den · Tribal Intel",
                        title = "Tribal",
                        accentTail = "Intel.",
                        subtitle = "Guides and educational resources for care delivery",
                        trailing = {
                            if (flags.trainingDocsCreate) {
                                AuntieDashedAddButton(
                                    text = "Add intel",
                                    onClick = {
                                        editingDoc = null
                                        viewModel.resetTrainingDocDraft()
                                        showAddForm = true
                                    },
                                    leadingIcon = Lucide.BookOpen,
                                )
                            }
                        },
                    )
                }

                // Honest queued-for-reconcile confirmation after a successful save.
                queuedMessage?.let { msg ->
                    item {
                        AuntieBanner(
                            tone = AuntieBannerTone.Suggestion,
                            title = "Queued for reconcile",
                            icon = Lucide.BookOpen,
                            pillLabel = "QUEUED",
                        ) {
                            Text(text = msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        }
                    }
                }

                // Add/Edit form panel. Only reachable while flags.trainingDocsCreate is on.
                if (flags.trainingDocsCreate && showAddForm) {
                    item {
                        AddDocumentForm(
                            viewModel = viewModel,
                            editingDoc = editingDoc,
                            onCancel = { showAddForm = false; viewModel.resetTrainingDocDraft() },
                            onSaved = { showAddForm = false },
                        )
                    }
                }

                // Surface a load / permission error loudly before anything else.
                error?.let { msg ->
                    item {
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            title = "Couldn't load training documents",
                            icon = Lucide.TriangleAlert,
                        ) {
                            Text(
                                text = msg,
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }
                }

                if (trainingDocs.isNotEmpty()) {
                    item { SummaryRow(trainingDocs) }

                    item {
                        DenPanel(
                            title = "Document library",
                            subtitle = "Search across titles, content, and comm. type.",
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            AuntieField(
                                value = searchQuery,
                                onValueChange = { searchQuery = it },
                                placeholder = "Search documents...",
                                leading = { Icon(Lucide.Search, contentDescription = null) },
                                modifier = Modifier.fillMaxWidth(),
                            )

                            // Comm. Type quick filters (always on): selection narrows the
                            // displayed list locally over the loaded docs.
                            val commTypeOptions = remember(trainingDocs) {
                                trainingDocs.map { it.communicationType }
                                    .filter { it.isNotBlank() }
                                    .distinct()
                            }
                            if (commTypeOptions.isNotEmpty()) {
                                Spacer(Modifier.height(AuntieTheme.dims.space3))
                                Text(
                                    text = "FILTER BY COMM. TYPE",
                                    style = AuntieTheme.typography.mono,
                                    color = c.primary,
                                )
                                Spacer(Modifier.height(AuntieTheme.dims.space2))
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
                                ) {
                                    commTypeOptions.forEach { opt ->
                                        AuntieChip(
                                            selected = commTypeFilter == opt,
                                            onClick = {
                                                commTypeFilter = if (commTypeFilter == opt) null else opt
                                            },
                                            label = opt,
                                        )
                                    }
                                }
                            }

                            Spacer(Modifier.height(AuntieTheme.dims.space4))

                            // Local in-memory filter: free-text search across the loaded
                            // list, then the optional comm-type narrowing (only when the
                            // filter chips are live).
                            val docs = trainingDocs
                                .filter { doc ->
                                    searchQuery.isBlank() ||
                                        doc.title.contains(searchQuery, ignoreCase = true) ||
                                        doc.content.contains(searchQuery, ignoreCase = true) ||
                                        doc.communicationType.contains(searchQuery, ignoreCase = true)
                                }
                                .let { result -> trainingDocsCommTypeFilter(result, commTypeFilter) }

                            if (docs.isEmpty()) {
                                if (searchQuery.isBlank()) {
                                    EmptyHint("No documents match the current filter.")
                                } else {
                                    EmptyHint("No results for \"$searchQuery\".")
                                }
                            } else {
                                Column(
                                    verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
                                ) {
                                    docs.forEachIndexed { i, doc ->
                                        DocRow(
                                            doc = doc,
                                            kinfolk = kinfolkDirectory,
                                            kin = kinDirectory,
                                            showDivider = i < docs.lastIndex,
                                            canManage = flags.trainingDocsCreate,
                                            onEdit = {
                                                editingDoc = doc
                                                viewModel.setTrainingDocAttachments(doc.attachments)
                                                viewModel.loadKinForSelectedKinfolk(doc.targetKinfolkId.ifBlank { doc.kinfolkRef })
                                                showAddForm = true
                                            },
                                            onDelete = { viewModel.deleteTrainingDocument(doc.id) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                } else if (!isLoading) {
                    item {
                        DenPanel(
                            title = "No Tribal Intel yet",
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            EmptyHint("Training materials and guides will appear here once uploaded.")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryRow(docs: List<TrainingDocument>) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
    ) {
        StatCard(
            label = "Total",
            value = "${docs.size}",
            trend = "documents on file",
            tone = AuntieStatusTone.Orange,
            feature = true,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "Comm. types",
            value = "${docs.map { it.communicationType }.filter { it.isNotBlank() }.distinct().size}",
            trend = "distinct categories",
            tone = AuntieStatusTone.Teal,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "With content",
            value = "${docs.count { it.content.isNotBlank() }}",
            trend = "have a body",
            tone = AuntieStatusTone.Purple,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun DocRow(
    doc: TrainingDocument,
    kinfolk: List<com.tribetails.auntieos.data.model.Kinfolk>,
    kin: List<com.tribetails.auntieos.data.model.Kin>,
    showDivider: Boolean,
    canManage: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val c = AuntieTheme.colors
    // Who the entry is about, said out loud: the kind of target AND the name of
    // the one it points at. This row used to print "Related to: <raw id>" while
    // the form's only wide chip said "Whole household" whatever the real target
    // was, which is the defect issue #393 reports.
    val targetLabel = tribalIntelTargetLabel(doc, kinfolk, kin)

    Column {
        AuntieEntityRow(
            title = doc.title.ifBlank { "Untitled Document" },
            subtitle = doc.uploadedAt.ifBlank { "-" },
            showDivider = false,
            leading = {
                AuntieIconTile(icon = Lucide.BookOpen, tone = AuntieStatusTone.Orange)
            },
            trailing = {
                if (doc.communicationType.isNotBlank()) {
                    AuntieStatusPill(
                        label = doc.communicationType,
                        tone = AuntieStatusTone.Orange,
                        mono = true,
                    )
                }
            },
        )

        if (doc.content.isNotBlank() || doc.notes.isNotBlank() || targetLabel != null) {
            Column(
                modifier = Modifier.padding(
                    start = AuntieTheme.dims.space3,
                    end = AuntieTheme.dims.space3,
                    bottom = AuntieTheme.dims.space3,
                ),
                verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
            ) {
                if (doc.content.isNotBlank()) {
                    val preview = if (!expanded && doc.content.length > 200) {
                        doc.content.take(200) + "..."
                    } else {
                        doc.content
                    }
                    Text(
                        text = preview,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textPrimary.copy(alpha = 0.82f),
                    )
                    if (doc.content.length > 200) {
                        Text(
                            text = if (expanded) "Show Less" else "Show More",
                            style = AuntieTheme.typography.labelMedium,
                            color = c.primary,
                            modifier = Modifier.clickable { expanded = !expanded },
                        )
                    }
                }
                if (doc.notes.isNotBlank()) {
                    Text(
                        text = "Notes: ${doc.notes}",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                if (targetLabel != null) {
                    Text(
                        text = targetLabel,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.primary.copy(alpha = 0.85f),
                    )
                }
                if (doc.attachments.isNotEmpty()) {
                    Text(
                        text = "Attachments: ${doc.attachments.joinToString { it.fileName.ifBlank { "file" } }}",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                if (doc.reconcileStatus.isNotBlank()) {
                    AuntieStatusPill(
                        label = "reconcile: ${doc.reconcileStatus}",
                        tone = if (doc.reconcileStatus == "applied") AuntieStatusTone.Teal else AuntieStatusTone.Orange,
                        mono = true,
                    )
                    if (doc.reconcileNotes.isNotBlank()) {
                        Text(
                            text = doc.reconcileNotes,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textFaint,
                        )
                    }
                }
                if (canManage && doc.id.isNotBlank()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3, Alignment.End),
                    ) {
                        GhostButton(label = "Edit", onClick = onEdit)
                        GhostButton(label = "Delete", onClick = { confirmDelete = true })
                    }
                }
            }
        }
    }

    AuntieDialog(
        visible = confirmDelete,
        title = "Delete this Tribal Intel entry?",
        onDismiss = { confirmDelete = false },
        footer = {
            GhostButton(label = "Cancel", onClick = { confirmDelete = false })
            PrimaryButton(label = "Delete", onClick = { confirmDelete = false; onDelete() })
        },
    ) {
        Text(
            text = "This removes the source note. It does NOT unmerge any text the reconcile " +
                "pipeline has already folded into the dossier, the household bank or the 411. Those " +
                "summaries keep prior content until they are regenerated.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
    }
}

/**
 * Add/Edit form for a Tribal Intel entry (spec 23). Wired to [AdminDataViewModel]:
 * Auntie types free notes, attaches Cloudinary files (TRIBAL_INTEL pipeline), and
 * targets a Kinfolk (household) or single Kin (pet) via real directory pickers.
 * Save routes through the create/update admin callable and the entry is queued for
 * the nightly reconcile pipeline. The form never claims an instant dossier update.
 */
@Composable
private fun AddDocumentForm(
    viewModel: AdminDataViewModel,
    editingDoc: TrainingDocument?,
    onCancel: () -> Unit,
    onSaved: () -> Unit,
) {
    val context = LocalContext.current
    val kinfolkDirectory by viewModel.kinfolkDirectory.collectAsState()
    val kinForSelected by viewModel.kinForSelectedKinfolk.collectAsState()
    val attachments by viewModel.trainingDocAttachments.collectAsState()
    val isUploading by viewModel.trainingDocUploading.collectAsState()
    val isSaving by viewModel.trainingDocSaving.collectAsState()
    val error by viewModel.error.collectAsState()

    var title by remember(editingDoc) { mutableStateOf(editingDoc?.title ?: "") }
    var content by remember(editingDoc) { mutableStateOf(editingDoc?.content ?: "") }
    var notes by remember(editingDoc) { mutableStateOf(editingDoc?.notes ?: "") }
    // The SAME classifier the list row renders with, on purpose. Two readings of
    // one stored target is how an entry comes to read "Household" in the list and
    // open as "Kinfolk" in the editor.
    var targetType by remember(editingDoc) {
        mutableStateOf(
            editingDoc?.let { tribalIntelTarget(it).kind.name } ?: TRIBAL_INTEL_DEFAULT_TARGET_TYPE,
        )
    }
    var selectedKinfolkId by remember(editingDoc) {
        mutableStateOf(editingDoc?.let { it.targetKinfolkId.ifBlank { it.kinfolkRef } } ?: "")
    }
    var selectedKinId by remember(editingDoc) { mutableStateOf(editingDoc?.targetKinId ?: "") }

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent(),
    ) { uri -> if (uri != null) viewModel.uploadTribalIntelAttachment(context, uri) }

    // ── the stale target (issue #460) ───────────────────────────────────────
    // A legacy row stores a person NAME where a newer one stores an id. The
    // dropdown found no match for it and fell back to its placeholder, so the
    // form showed a blank target for a note that plainly named somebody — and
    // `hasTarget` counted the name as a target and let it be saved back. The
    // stored value is surfaced instead, and the save is refused until a real
    // record is chosen, which is also what the callable now enforces.
    val staleAnchor = tribalIntelStaleTargetMessage(
        selectedKinfolkId,
        kinfolkDirectory.map { it.id },
        anchorNounFor(targetType),
    )
    val staleKin =
        if (targetType == "KIN") {
            tribalIntelStaleTargetMessage(selectedKinId, kinForSelected.map { it.id }, TribalIntelTargetNoun.KIN)
        } else {
            null
        }

    val hasContent = title.isNotBlank() || content.isNotBlank() || attachments.isNotEmpty()
    val hasTarget = selectedKinfolkId.isNotBlank() &&
        staleAnchor == null &&
        (targetType != "KIN" || (selectedKinId.isNotBlank() && staleKin == null))
    val canSave = hasContent && hasTarget && !isSaving && !isUploading

    DenPanel(
        title = if (editingDoc == null) "New Tribal Intel" else "Edit Tribal Intel",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = "Saved intel is queued for the next reconcile pass, then folded into the " +
                "targeted client's dossier and the pet's 411. Attachments are cited as provenance " +
                "only (the AI does not read image contents).",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )

        error?.let { msg ->
            Spacer(Modifier.height(AuntieTheme.dims.space3))
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not save",
                icon = Lucide.TriangleAlert,
            ) {
                Text(text = msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }

        Spacer(Modifier.height(AuntieTheme.dims.space4))

        AuntieFieldLabel(text = "Title")
        AuntieField(value = title, onValueChange = { title = it }, placeholder = "Short label", modifier = Modifier.fillMaxWidth())

        Spacer(Modifier.height(AuntieTheme.dims.space4))

        AuntieFieldLabel(text = "Intel")
        AuntieField(
            value = content,
            onValueChange = { content = it },
            placeholder = "What should the AI know about this client or pet?",
            singleLine = false,
            minLines = 4,
            maxLines = 12,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(AuntieTheme.dims.space4))

        AuntieFieldLabel(text = "Notes", optionalNote = "optional")
        AuntieField(value = notes, onValueChange = { notes = it }, placeholder = "Internal notes", modifier = Modifier.fillMaxWidth())

        Spacer(Modifier.height(AuntieTheme.dims.space5))

        // ---- Target picker ----
        Text(text = "TARGET", style = AuntieTheme.typography.mono, color = AuntieTheme.colors.primary)
        Spacer(Modifier.height(AuntieTheme.dims.space2))
        Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
            TRIBAL_INTEL_TARGET_TYPES.forEach { t ->
                AuntieChip(
                    selected = targetType == t,
                    // Any target but KIN names no animal, so a pet id left over
                    // from a previous choice must go. The server coerces it away
                    // too, but a draft that still carries it would show the
                    // operator a pet they are not targeting.
                    onClick = { targetType = t; if (t != "KIN") selectedKinId = "" },
                    label = targetTypeLabel(t),
                )
            }
        }

        Spacer(Modifier.height(AuntieTheme.dims.space2))

        Text(
            text = TRIBAL_INTEL_TARGET_HINT,
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )

        Spacer(Modifier.height(AuntieTheme.dims.space3))

        AuntieDropdownField(
            label = if (targetType == "KINFOLK") "Kinfolk" else "Household",
            value = kinfolkDirectory.firstOrNull { it.id == selectedKinfolkId },
            options = kinfolkDirectory,
            onSelect = { kf ->
                selectedKinfolkId = kf.id
                selectedKinId = ""
                viewModel.loadKinForSelectedKinfolk(kf.id)
            },
            displayText = {
                if (targetType == "KINFOLK") kinfolkDisplayName(it)
                else householdLabel(it.lastName).ifBlank { kinfolkDisplayName(it) }
            },
            placeholder = if (targetType == "KINFOLK") "Select a kinfolk..." else "Select a household...",
            modifier = Modifier.fillMaxWidth(),
        )

        // The stored value the dropdown could not place, kept on screen so the
        // note is never silently detached from whoever it was about.
        staleAnchor?.let { msg ->
            Spacer(Modifier.height(AuntieTheme.dims.space2))
            Text(
                text = tribalIntelStaleOptionLabel(selectedKinfolkId),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.error,
            )
            Text(text = msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }

        if (targetType == "KIN") {
            Spacer(Modifier.height(AuntieTheme.dims.space3))
            AuntieDropdownField(
                label = "Pet",
                value = kinForSelected.firstOrNull { it.id == selectedKinId },
                options = kinForSelected,
                onSelect = { selectedKinId = it.id },
                displayText = { it.name.ifBlank { it.id } },
                placeholder = "Select a pet...",
                enabled = selectedKinfolkId.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
            // Same reason as the household picker: a stale pet id stays readable.
            staleKin?.let { msg ->
                Spacer(Modifier.height(AuntieTheme.dims.space2))
                Text(
                    text = tribalIntelStaleOptionLabel(selectedKinId),
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
                Text(text = msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }

        Spacer(Modifier.height(AuntieTheme.dims.space5))

        // ---- Attachments ----
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "ATTACHMENTS",
                style = AuntieTheme.typography.mono,
                color = AuntieTheme.colors.primary,
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label = if (isUploading) "Uploading..." else "Attach file",
                onClick = { if (!isUploading) filePicker.launch("*/*") },
            )
        }
        if (attachments.isNotEmpty()) {
            Spacer(Modifier.height(AuntieTheme.dims.space2))
            Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
                attachments.forEach { att ->
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = att.fileName.ifBlank { att.cloudinaryPublicId },
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        GhostButton(label = "Remove", onClick = { viewModel.removeTrainingDocAttachment(att.cloudinaryPublicId) })
                    }
                }
            }
        }

        Spacer(Modifier.height(AuntieTheme.dims.space5))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3, Alignment.End),
        ) {
            GhostButton(label = "Cancel", onClick = onCancel)
            PrimaryButton(
                label = if (isSaving) "Saving..." else "Save",
                onClick = {
                    val kinId = if (targetType == "KIN") selectedKinId else null
                    if (editingDoc == null) {
                        viewModel.createTrainingDocument(title, content, notes, targetType, selectedKinfolkId, kinId, attachments) { err ->
                            if (err == null) onSaved()
                        }
                    } else {
                        viewModel.updateTrainingDocument(editingDoc.id, title, content, notes, targetType, selectedKinfolkId, kinId, attachments) { err ->
                            if (err == null) onSaved()
                        }
                    }
                },
                enabled = canSave,
            )
        }
    }
}
