package com.tribetails.auntieos.web.screens.media
import androidx.compose.runtime.Stable
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
@Stable
data class MediaGalleryUiState(
    val items: List<MediaFile> = emptyList(),
    val isLoading: Boolean = true,
    val isUploading: Boolean = false,
    val error: String? = null,
)
class MediaGalleryViewModel(
    private val entityId: String,
    private val entityType: String,
    private val dataSource: AuntieDataSource,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val _uiState = MutableStateFlow(MediaGalleryUiState())
    val uiState: StateFlow<MediaGalleryUiState> = _uiState.asStateFlow()
    init {
        scope.launch {
            dataSource.mediaStream(entityId, entityType).collect { result ->
                when (result) {
                    FirestoreResult.Loading -> _uiState.update { it.copy(isLoading = true) }
                    is FirestoreResult.Data -> _uiState.update {
                        it.copy(isLoading = false, items = result.value, error = null)
                    }
                    is FirestoreResult.Error -> _uiState.update {
                        it.copy(isLoading = false, error = result.message)
                    }
                }
            }
        }
    }
    fun upload(bytes: ByteArray, mimeType: String) {
        if (entityId.isBlank()) {
            _uiState.update { it.copy(error = "Cannot upload: no entity selected. Pick an entity first.") }
            return
        }
        scope.launch {
            _uiState.update { it.copy(isUploading = true) }
            // Run-4 #4b: multi-file upload (was single). bytes/mimeType ignored by the
            // picker flow (the JS bridge opens its own multi-picker); kept for compat.
            // WARNING-39: wrap in try-catch so a require() throw inside the dataSource
            // (e.g. blank entityId guard) does not leave isUploading = true forever.
            try {
                when (val result = dataSource.pickAndUploadMedia(entityId, entityType, max = 10)) {
                    is WriteResult.Ok  -> _uiState.update { it.copy(isUploading = false, error = null) }
                    is WriteResult.Err -> _uiState.update { it.copy(isUploading = false, error = result.message) }
                }
            } catch (t: Throwable) {
                _uiState.update { it.copy(isUploading = false, error = "Upload failed: ${t.message ?: "unexpected error"}") }
            }
        }
    }
    fun deleteMedia(mediaId: String) {
        scope.launch {
            when (val result = dataSource.deleteMedia(mediaId)) {
                is WriteResult.Ok  -> _uiState.update { it.copy(error = null) }
                is WriteResult.Err -> _uiState.update { it.copy(error = result.message) }
            }
        }
    }
    fun setProfilePhoto(mediaFileId: String) {
        scope.launch {
            when (val result = dataSource.setMediaProfilePhoto(mediaFileId, entityType, entityId)) {
                is WriteResult.Ok  -> _uiState.update { it.copy(error = null) }
                is WriteResult.Err -> _uiState.update { it.copy(error = result.message) }
            }
            // The badge re-renders on the next mediaStream emission (the callable
            // wrote isProfilePhoto), so no optimistic local mutation is needed.
        }
    }
    fun clearError() {
        _uiState.update { it.copy(error = null) }
    }
}
