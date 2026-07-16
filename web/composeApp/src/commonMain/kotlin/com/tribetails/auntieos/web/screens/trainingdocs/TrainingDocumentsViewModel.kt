package com.tribetails.auntieos.web.screens.trainingdocs

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.TrainingDocAttachment
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

interface TrainingDocsDataSource {
    fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>>

    // Tribal Intel write tool (spec 23). All three frontends route writes through
    // the admin callables; attachments are uploaded first via uploadMedia.
    fun kinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>>
    fun kinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>>

    suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile>

    suspend fun createTrainingDocument(
        title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ): WriteResult<String>

    suspend fun updateTrainingDocument(
        docId: String, title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ): WriteResult<Unit>

    suspend fun deleteTrainingDocument(docId: String): WriteResult<Unit>
}

/** Form draft for create/edit of a Tribal Intel entry. */
data class TribalIntelDraft(
    val editingId: String? = null,
    val title: String = "",
    val content: String = "",
    val notes: String = "",
    val targetType: String = "KINFOLK",       // KINFOLK | KIN
    val selectedKinfolkId: String = "",
    val selectedKinId: String = "",
    val attachments: List<TrainingDocAttachment> = emptyList(),
) {
    /** A save is allowed only with text and a resolved target. */
    val hasContent: Boolean get() = title.isNotBlank() || content.isNotBlank() || attachments.isNotEmpty()
    val hasTarget: Boolean
        get() = selectedKinfolkId.isNotBlank() && (targetType != "KIN" || selectedKinId.isNotBlank())
    val canSave: Boolean get() = hasContent && hasTarget
}

data class TrainingDocumentsUiState(
    val allDocs: List<TrainingDocument> = emptyList(),
    val displayedDocs: List<TrainingDocument> = emptyList(),
    val searchQuery: String = "",
    val isLoading: Boolean = true,
    val errorMessage: String? = null,

    // Picker + form state.
    val kinfolk: List<Kinfolk> = emptyList(),
    val kinForSelected: List<Kin> = emptyList(),
    val draft: TribalIntelDraft = TribalIntelDraft(),
    val isSaving: Boolean = false,
    val isUploading: Boolean = false,
    // Honest success: the dossier/411 fold only happens on the next reconcile pass.
    val queuedMessage: String? = null,
)

class TrainingDocumentsViewModel(private val dataSource: TrainingDocsDataSource) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private val _uiState = MutableStateFlow(TrainingDocumentsUiState())
    val uiState: StateFlow<TrainingDocumentsUiState> = _uiState.asStateFlow()

    init {
        scope.launch {
            dataSource.trainingDocsStream().collect { result ->
                when (result) {
                    FirestoreResult.Loading -> _uiState.update { it.copy(isLoading = true) }
                    is FirestoreResult.Data -> _uiState.update { s ->
                        // Drop content-less junk docs (leftover all-null import/seed
                        // rows with no title and no content) so they do not surface
                        // as "Untitled Document" or inflate the totals.
                        val real = result.value.filter {
                            it.title.isNotBlank() || it.content.isNotBlank()
                        }
                        s.copy(
                            allDocs      = real,
                            displayedDocs = filter(real, s.searchQuery),
                            isLoading    = false,
                            errorMessage = null,
                        )
                    }
                    is FirestoreResult.Error -> _uiState.update {
                        it.copy(isLoading = false, errorMessage = result.message)
                    }
                }
            }
        }
        scope.launch {
            dataSource.kinfolkStream().collect { result ->
                if (result is FirestoreResult.Data) {
                    _uiState.update { it.copy(kinfolk = result.value) }
                }
            }
        }
    }

    fun search(query: String) {
        _uiState.update { s ->
            s.copy(searchQuery = query, displayedDocs = filter(s.allDocs, query))
        }
    }

    private fun filter(docs: List<TrainingDocument>, query: String): List<TrainingDocument> {
        if (query.isBlank()) return docs
        return docs.filter { doc ->
            doc.title.contains(query, ignoreCase = true) ||
            doc.content.contains(query, ignoreCase = true) ||
            doc.communicationType.contains(query, ignoreCase = true)
        }
    }

    // ---- draft + picker ----

    fun updateDraft(transform: (TribalIntelDraft) -> TribalIntelDraft) {
        _uiState.update { it.copy(draft = transform(it.draft), queuedMessage = null) }
    }

    fun selectKinfolk(kinfolkId: String) {
        _uiState.update { it.copy(draft = it.draft.copy(selectedKinfolkId = kinfolkId, selectedKinId = ""), kinForSelected = emptyList(), queuedMessage = null) }
        if (kinfolkId.isBlank()) return
        scope.launch {
            dataSource.kinStream(kinfolkId).collect { result ->
                if (result is FirestoreResult.Data) {
                    _uiState.update { it.copy(kinForSelected = result.value) }
                }
            }
        }
    }

    fun startEdit(doc: TrainingDocument) {
        val draft = TribalIntelDraft(
            editingId = doc._id,
            title = doc.title,
            content = doc.content,
            notes = doc.notes,
            targetType = doc.targetType.ifBlank { "KINFOLK" },
            selectedKinfolkId = doc.targetKinfolkId.ifBlank { doc.kinfolkRef },
            selectedKinId = doc.targetKinId,
            attachments = doc.attachments,
        )
        _uiState.update { it.copy(draft = draft, queuedMessage = null, errorMessage = null) }
        if (draft.selectedKinfolkId.isNotBlank()) selectKinfolk(draft.selectedKinfolkId)
    }

    fun resetDraft() {
        _uiState.update { it.copy(draft = TribalIntelDraft(), kinForSelected = emptyList(), queuedMessage = null) }
    }

    // ---- attachments ----

    fun attachFile(bytes: ByteArray, mimeType: String, fileName: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            _uiState.update { it.copy(isUploading = true, errorMessage = null) }
            val entityId = _uiState.value.draft.editingId ?: "pending"
            when (val r = dataSource.uploadMedia(entityId, "TRIBAL_INTEL", bytes, mimeType)) {
                is WriteResult.Ok -> {
                    val m = r.value
                    val att = TrainingDocAttachment(
                        storageUrl = m.storageUrl,
                        cloudinaryPublicId = m.cloudinaryPublicId,
                        fileType = m.fileType,
                        mimeType = m.mimeType.ifBlank { mimeType },
                        fileName = m.originalFileName.ifBlank { fileName },
                    )
                    _uiState.update { it.copy(isUploading = false, draft = it.draft.copy(attachments = it.draft.attachments + att)) }
                    onDone(true)
                }
                is WriteResult.Err -> {
                    _uiState.update { it.copy(isUploading = false, errorMessage = "Attachment upload failed: ${r.message}") }
                    onDone(false)
                }
            }
        }
    }

    fun removeAttachment(publicId: String) {
        _uiState.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.filterNot { a -> a.cloudinaryPublicId == publicId })) }
    }

    // ---- save / delete ----

    fun saveDraft(onSuccess: () -> Unit = {}) {
        val draft = _uiState.value.draft
        if (!draft.canSave) {
            _uiState.update { it.copy(errorMessage = "Add a title or note and pick a target before saving.") }
            return
        }
        scope.launch {
            _uiState.update { it.copy(isSaving = true, errorMessage = null, queuedMessage = null) }
            val targetKinId = if (draft.targetType == "KIN") draft.selectedKinId else null
            val result: WriteResult<*> = if (draft.editingId == null) {
                dataSource.createTrainingDocument(
                    draft.title, draft.content, draft.notes, "note",
                    draft.targetType, draft.selectedKinfolkId, targetKinId, draft.attachments,
                )
            } else {
                dataSource.updateTrainingDocument(
                    draft.editingId, draft.title, draft.content, draft.notes, "note",
                    draft.targetType, draft.selectedKinfolkId, targetKinId, draft.attachments,
                )
            }
            when (result) {
                is WriteResult.Ok -> {
                    _uiState.update {
                        it.copy(
                            isSaving = false,
                            draft = TribalIntelDraft(),
                            kinForSelected = emptyList(),
                            queuedMessage = "Queued for reconcile. The dossier and 411 update on the next reconcile pass, not instantly.",
                        )
                    }
                    onSuccess()
                }
                is WriteResult.Err -> _uiState.update {
                    it.copy(isSaving = false, errorMessage = result.message)
                }
            }
        }
    }

    fun deleteDoc(docId: String, onSuccess: () -> Unit = {}) {
        scope.launch {
            _uiState.update { it.copy(isSaving = true, errorMessage = null) }
            when (val r = dataSource.deleteTrainingDocument(docId)) {
                is WriteResult.Ok -> {
                    _uiState.update { it.copy(isSaving = false) }
                    onSuccess()
                }
                is WriteResult.Err -> _uiState.update { it.copy(isSaving = false, errorMessage = r.message) }
            }
        }
    }
}
