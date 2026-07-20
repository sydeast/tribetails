package com.tribetails.auntieos.web.screens.trainingdocs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.BookOpen
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.TrainingDocAttachment
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipGroup
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDashedAddButton
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard
import kotlinx.coroutines.flow.Flow

/**
 * Client-side comm-type narrowing for the Tribal Intel library. A null selection
 * returns the list unchanged; otherwise keeps docs whose communicationType matches
 * exactly. Pure, so it is unit-tested directly (mirrors the Android helper).
 */
internal fun trainingDocsCommTypeFilter(
    docs: List<TrainingDocument>,
    selected: String?,
): List<TrainingDocument> =
    if (selected == null) docs else docs.filter { it.communicationType == selected }

private class FirestoreTrainingDocsDataSource(
    private val client: FirestoreClient,
) : TrainingDocsDataSource {
    override fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> =
        client.trainingDocsStream()

    override fun kinfolkStream() = client.kinfolkStream()
    override fun kinStream(kinfolkId: String) = client.kinStream(kinfolkId)

    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) =
        client.uploadMedia(entityId, entityType, bytes, mimeType)

    override suspend fun createTrainingDocument(
        title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ) = client.createTrainingDocument(title, content, notes, communicationType, targetType, targetKinfolkId, targetKinId, attachments)

    override suspend fun updateTrainingDocument(
        docId: String, title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ) = client.updateTrainingDocument(docId, title, content, notes, communicationType, targetType, targetKinfolkId, targetKinId, attachments)

    override suspend fun deleteTrainingDocument(docId: String) = client.deleteTrainingDocument(docId)
}

@Composable
fun TrainingDocumentsScreen() {
    val flags = LocalFeatureFlags.current
    val client = remember { FirestoreClient() }
    val dataSource = remember { FirestoreTrainingDocsDataSource(client) }
    val vm = remember { TrainingDocumentsViewModel(dataSource) }
    val state by vm.uiState.collectAsState()
    val c = AuntieTheme.colors

    // Add/Edit form visibility. Gated behind flags.trainingDocsCreate: off by default
    // so the trigger never shows a form that cannot save.
    var showAddForm by remember { mutableStateOf(false) }
    // Local Comm. Type chip selection that narrows the displayed list.
    var commTypeFilter by remember { mutableStateOf(setOf<String>()) }

    ScreenScaffold {
        DenScreenHeading(
            // Renamed "Tribal Intel" (LOCKED Decision 3). TODO(auntie copy): final
            // subtitle wording is author-owned; the heading name is the decided rename.
            kicker     = "The Den · Tribal Intel",
            title      = "Tribal",
            accentTail = "Intel.",
            subtitle   = "Guides and educational resources for care delivery",
            trailing   = {
                if (flags.trainingDocsCreate) {
                    // Backed by the createTrainingDocument admin callable (spec 23).
                    AuntieDashedAddButton(
                        text        = "Add intel",
                        onClick     = { vm.resetDraft(); showAddForm = true },
                        leadingIcon = Lucide.BookOpen,
                    )
                }
            },
        )

        Spacer(Modifier.height(AuntieTheme.dims.space4))

        // Honest queued-for-reconcile confirmation after a successful save.
        state.queuedMessage?.let { msg ->
            AuntieBanner(
                tone      = AuntieBannerTone.Suggestion,
                title     = "Queued for reconcile",
                icon      = Lucide.BookOpen,
                pillLabel = "QUEUED",
            ) {
                Text(
                    text  = msg,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
            Spacer(Modifier.height(AuntieTheme.dims.space3))
        }

        // Add/Edit form panel. Only reachable while flags.trainingDocsCreate is on.
        if (flags.trainingDocsCreate && showAddForm) {
            AddDocumentForm(
                vm      = vm,
                state   = state,
                onCancel = { showAddForm = false; vm.resetDraft() },
                onSaved  = { showAddForm = false },
            )
            Spacer(Modifier.height(AuntieTheme.dims.space3))
        }

        // Surface a deserialization / permission error loudly before anything else.
        state.errorMessage?.let { msg ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load training documents",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    text  = msg,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
            Spacer(Modifier.height(AuntieTheme.dims.space3))
        }

        when {
            state.isLoading -> Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
                repeat(3) { ShimmerCard(height = 80.dp) }
            }
            state.allDocs.isNotEmpty() -> {
                SummaryRow(state.allDocs)
                Spacer(Modifier.height(AuntieTheme.dims.space5))

                DenPanel(
                    title    = "Document library",
                    subtitle = "Search across titles, content, and comm. type.",
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    AuntieSearchField(
                        value         = state.searchQuery,
                        onValueChange = { vm.search(it) },
                        placeholder   = "Search documents...",
                        leadingIcon   = Lucide.Search,
                        onClear       = { vm.search("") },
                        modifier      = Modifier.fillMaxWidth(),
                    )

                    // Comm. Type quick filters (live). Selecting a chip narrows the
                    // displayed list locally via trainingDocsCommTypeFilter, so the chips
                    // never mislead by visually implying filtering without doing it.
                    val commTypeOptions = remember(state.allDocs) {
                        state.allDocs.map { it.communicationType }
                            .filter { it.isNotBlank() }
                            .distinct()
                    }
                    if (commTypeOptions.isNotEmpty()) {
                        Spacer(Modifier.height(AuntieTheme.dims.space3))
                        Text(
                            text  = "FILTER BY COMM. TYPE",
                            style = AuntieTheme.typography.mono,
                            color = c.primary,
                        )
                        Spacer(Modifier.height(AuntieTheme.dims.space2))
                        AuntieChipGroup(
                            options           = commTypeOptions,
                            selected          = commTypeFilter,
                            onSelectionChange = { commTypeFilter = it },
                            label             = { it },
                            singleSelect      = true,
                            clearable         = true,
                            modifier          = Modifier.fillMaxWidth(),
                        )
                    }

                    Spacer(Modifier.height(AuntieTheme.dims.space4))

                    // Apply the local comm-type narrowing on top of the VM search result.
                    // The chip group is single-select, so collapse the set to one value.
                    val docs = trainingDocsCommTypeFilter(state.displayedDocs, commTypeFilter.firstOrNull())

                    if (docs.isEmpty()) {
                        EmptySearchState(state.searchQuery)
                    } else {
                        DocList(
                            docs       = docs,
                            canManage  = flags.trainingDocsCreate,
                            onEdit     = { doc -> vm.startEdit(doc); showAddForm = true },
                            onDelete   = { docId -> vm.deleteDoc(docId) },
                        )
                    }
                }
            }
            else -> EmptyState()
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
private fun DocList(
    docs: List<TrainingDocument>,
    canManage: Boolean,
    onEdit: (TrainingDocument) -> Unit,
    onDelete: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
        docs.forEach { doc -> DocCard(doc, canManage, onEdit, onDelete) }
    }
}

@Composable
private fun DocCard(
    doc: TrainingDocument,
    canManage: Boolean,
    onEdit: (TrainingDocument) -> Unit,
    onDelete: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val c = AuntieTheme.colors

    GlassSurface(modifier = Modifier.fillMaxWidth(), cornerRadius = 18.dp) {
        Column(modifier = Modifier.padding(AuntieTheme.dims.space5)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    val blank = doc.title.isBlank()
                    Text(
                        text  = doc.title.ifBlank { "Untitled Document" },
                        style = AuntieTheme.typography.titleMedium,
                        color = if (blank) c.textDim else c.textPrimary,
                        fontStyle = if (blank) FontStyle.Italic else FontStyle.Normal,
                    )
                    if (doc.communicationType.isNotBlank()) {
                        Spacer(Modifier.height(AuntieTheme.dims.space2))
                        AuntieChip(
                            label = doc.communicationType,
                            tone  = AuntieChipTone.Orange,
                            mono  = true,
                        )
                    }
                }
                Spacer(Modifier.width(AuntieTheme.dims.space3))
                Text(
                    // Mockup shows a literal "-" for a missing date; mirror that
                    // rather than rendering nothing.
                    text  = doc.uploadedAt.ifBlank { "-" },
                    style = AuntieTheme.typography.mono,
                    color = c.textFaint,
                )
            }

            if (doc.content.isNotBlank()) {
                Spacer(Modifier.height(AuntieTheme.dims.space3))
                val preview = if (!expanded && doc.content.length > 200)
                    doc.content.take(200) + "..." else doc.content
                Text(
                    text  = preview,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary.copy(alpha = 0.82f),
                )
                if (doc.content.length > 200) {
                    Spacer(Modifier.height(AuntieTheme.dims.space1))
                    Text(
                        text  = if (expanded) "Show Less" else "Show More",
                        style = AuntieTheme.typography.labelMedium,
                        color = c.primary,
                        modifier = Modifier.clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { expanded = !expanded },
                    )
                }
            }

            if (doc.notes.isNotBlank()) {
                Spacer(Modifier.height(AuntieTheme.dims.space3))
                Text(
                    text  = "Notes: ${doc.notes}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }

            if (doc.kinfolkRef.isNotBlank()) {
                Spacer(Modifier.height(AuntieTheme.dims.space1))
                Text(
                    text  = "Related to: ${doc.kinfolkRef}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.primary.copy(alpha = 0.85f),
                )
            }

            // Attachment provenance chips (file names only; never claims analysis).
            if (doc.attachments.isNotEmpty()) {
                Spacer(Modifier.height(AuntieTheme.dims.space2))
                Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
                    doc.attachments.take(6).forEach { att ->
                        AuntieChip(label = att.fileName.ifBlank { "file" }, tone = AuntieChipTone.Teal, mono = true)
                    }
                }
            }

            // Reconcile status surfaced honestly so skipped/errored intel is visible.
            if (doc.reconcileStatus.isNotBlank()) {
                Spacer(Modifier.height(AuntieTheme.dims.space2))
                val tone = when (doc.reconcileStatus) {
                    "applied"  -> AuntieChipTone.Teal
                    "pending"  -> AuntieChipTone.Orange
                    "error", "skipped" -> AuntieChipTone.Orange
                    else        -> AuntieChipTone.Orange
                }
                AuntieChip(label = "reconcile: ${doc.reconcileStatus}", tone = tone, mono = true)
                if (doc.reconcileNotes.isNotBlank()) {
                    Spacer(Modifier.height(AuntieTheme.dims.space1))
                    Text(
                        text  = doc.reconcileNotes,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textFaint,
                    )
                }
            }

            if (canManage && doc._id.isNotBlank()) {
                Spacer(Modifier.height(AuntieTheme.dims.space3))
                Row(horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3, Alignment.End), modifier = Modifier.fillMaxWidth()) {
                    GhostButton(label = "Edit", onClick = { onEdit(doc) })
                    GhostButton(label = "Delete", onClick = { confirmDelete = true })
                }
            }
        }
    }

    AuntieDialog(
        visible   = confirmDelete,
        title     = "Delete this Tribal Intel entry?",
        onDismiss = { confirmDelete = false },
        footer    = {
            GhostButton(label = "Cancel", onClick = { confirmDelete = false })
            PrimaryButton(label = "Delete", onClick = { confirmDelete = false; onDelete(doc._id) })
        },
    ) {
        Text(
            text  = "This removes the source note. It does NOT unmerge any text the reconcile " +
                "pipeline has already folded into the dossier or 411. Those summaries keep prior " +
                "content until they are regenerated.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
    }
}

@Composable
private fun EmptyState() {
    AuntieEmptyState(
        title   = "No Tribal Intel yet",
        message = "Training materials and guides will appear here once uploaded",
        icon    = Lucide.BookOpen,
        modifier = Modifier.padding(vertical = AuntieTheme.dims.space5),
    )
}

@Composable
private fun EmptySearchState(query: String) {
    if (query.isBlank()) {
        EmptyHint("No documents match the current filter.")
    } else {
        AuntieEmptyState(
            title   = "No results for \"$query\"",
            icon    = Lucide.Search,
            compact = true,
            modifier = Modifier.padding(vertical = AuntieTheme.dims.space3),
        )
    }
}

/**
 * Add/Edit form for a Tribal Intel entry (spec 23). Auntie types free notes,
 * attaches Cloudinary files, and targets a Kinfolk (household) or a single Kin
 * (pet) via real directory pickers. Save routes through the createTrainingDocument
 * / updateTrainingDocument admin callable; the saved entry is queued for the
 * nightly reconcile pipeline, which folds it into the dossier + 411. The form
 * never claims an instant dossier update: the queued banner says so explicitly.
 */
@Composable
private fun AddDocumentForm(
    vm: TrainingDocumentsViewModel,
    state: TrainingDocumentsUiState,
    onCancel: () -> Unit,
    onSaved: () -> Unit,
) {
    val draft = state.draft
    val c = AuntieTheme.colors

    GlassSurface(modifier = Modifier.fillMaxWidth(), cornerRadius = 18.dp) {
        Column(modifier = Modifier.padding(AuntieTheme.dims.space5)) {
            Text(
                text  = if (draft.editingId == null) "New Tribal Intel" else "Edit Tribal Intel",
                style = AuntieTheme.typography.headlineSmall,
                color = c.textPrimary,
            )
            Spacer(Modifier.height(AuntieTheme.dims.space2))
            Text(
                text  = "Saved intel is queued for the next reconcile pass, then folded into the " +
                    "targeted client's dossier and the pet's 411. Attachments are cited as provenance " +
                    "only (the AI does not read image contents).",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            // Fail-loud error banner (upload or save failure).
            state.errorMessage?.let { msg ->
                Spacer(Modifier.height(AuntieTheme.dims.space3))
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Could not save",
                    icon  = Lucide.TriangleAlert,
                ) {
                    Text(text = msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            Spacer(Modifier.height(AuntieTheme.dims.space4))

            BottomBorderField(
                value         = draft.title,
                onValueChange = { v -> vm.updateDraft { it.copy(title = v) } },
                label         = "Title",
                placeholder   = "Short label",
                modifier      = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(AuntieTheme.dims.space4))

            MultilineField(
                value         = draft.content,
                onValueChange = { v -> vm.updateDraft { it.copy(content = v) } },
                label         = "Intel",
                placeholder   = "What should the AI know about this client or pet?",
                modifier      = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(AuntieTheme.dims.space4))

            BottomBorderField(
                value         = draft.notes,
                onValueChange = { v -> vm.updateDraft { it.copy(notes = v) } },
                label         = "Notes",
                placeholder   = "Optional internal notes",
                modifier      = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(AuntieTheme.dims.space5))

            // ---- Target picker ----
            Text(text = "TARGET", style = AuntieTheme.typography.mono, color = c.primary)
            Spacer(Modifier.height(AuntieTheme.dims.space2))
            AuntieChipGroup(
                options           = listOf("KINFOLK", "KIN"),
                selected          = setOf(draft.targetType),
                onSelectionChange = { sel ->
                    val t = sel.firstOrNull() ?: "KINFOLK"
                    vm.updateDraft { it.copy(targetType = t, selectedKinId = if (t == "KINFOLK") "" else it.selectedKinId) }
                },
                label             = { if (it == "KINFOLK") "Whole household" else "Single pet" },
                singleSelect      = true,
                clearable         = false,
                modifier          = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(AuntieTheme.dims.space3))

            AuntieSelectField(
                label       = "Kinfolk (household)",
                options     = listOf("") + state.kinfolk.map { it._id },
                selected    = draft.selectedKinfolkId,
                onSelect    = { vm.selectKinfolk(it) },
                optionLabel = { id ->
                    if (id.isBlank()) "Select a kinfolk..."
                    else state.kinfolk.firstOrNull { it._id == id }
                        ?.let { "${it.firstName} ${it.lastName}".trim().ifBlank { id } } ?: id
                },
                required    = true,
                modifier    = Modifier.fillMaxWidth(),
            )

            if (draft.targetType == "KIN") {
                Spacer(Modifier.height(AuntieTheme.dims.space3))
                AuntieSelectField(
                    label       = "Pet",
                    options     = listOf("") + state.kinForSelected.map { it._id },
                    selected    = draft.selectedKinId,
                    onSelect    = { id -> vm.updateDraft { it.copy(selectedKinId = id) } },
                    optionLabel = { id ->
                        if (id.isBlank()) "Select a pet..."
                        else state.kinForSelected.firstOrNull { it._id == id }?.name?.ifBlank { id } ?: id
                    },
                    required    = true,
                    enabled     = draft.selectedKinfolkId.isNotBlank(),
                    modifier    = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(AuntieTheme.dims.space5))

            // ---- Attachments ----
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = "ATTACHMENTS", style = AuntieTheme.typography.mono, color = c.primary, modifier = Modifier.weight(1f))
                GhostButton(
                    label   = if (state.isUploading) "Uploading..." else "Attach file",
                    onClick = { if (!state.isUploading) vm.attachFile(ByteArray(0), "", "") },
                )
            }
            if (draft.attachments.isNotEmpty()) {
                Spacer(Modifier.height(AuntieTheme.dims.space2))
                Column(verticalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
                    draft.attachments.forEach { att ->
                        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text  = att.fileName.ifBlank { att.cloudinaryPublicId },
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textPrimary,
                                modifier = Modifier.weight(1f),
                            )
                            GhostButton(label = "Remove", onClick = { vm.removeAttachment(att.cloudinaryPublicId) })
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
                    label   = if (state.isSaving) "Saving..." else "Save",
                    onClick = { vm.saveDraft(onSuccess = onSaved) },
                    enabled = draft.canSave && !state.isSaving && !state.isUploading,
                )
            }
        }
    }
}
