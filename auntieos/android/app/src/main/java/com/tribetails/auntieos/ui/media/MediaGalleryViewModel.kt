package com.tribetails.auntieos.ui.media

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class MediaGalleryUiState(
    val mediaFiles: List<MediaFile> = emptyList(),
    val albums: List<MediaAlbum> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
    val selectedMediaType: MediaType? = null,
    val currentAlbum: MediaAlbum? = null
)

class MediaGalleryViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(MediaGalleryUiState())
    val uiState: StateFlow<MediaGalleryUiState> = _uiState.asStateFlow()

    fun loadMedia(entityId: String, entityType: MediaEntityType) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            val mediaResult = repository.getMediaFiles(entityId, entityType)
            val albumsResult = repository.getMediaAlbums(entityId, entityType)

            mediaResult.onSuccess { media ->
                albumsResult.onSuccess { albums ->
                    _uiState.value = _uiState.value.copy(
                        mediaFiles = media,
                        albums = albums,
                        isLoading = false
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        mediaFiles = media,
                        albums = emptyList(),
                        isLoading = false,
                        error = "Failed to load albums: ${error.message}"
                    )
                }
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = "Failed to load media: ${error.message}"
                )
            }
        }
    }

    /**
     * Slice 7: set [mediaFile] as the profile photo for its owning entity via the
     * setMediaProfilePhoto callable, then reload so the ProfileBadge moves and the
     * stamped entity photo URL is reflected. Fail-loud: a callable error surfaces
     * into uiState.error, never swallowed.
     */
    fun setProfilePhoto(mediaFile: MediaFile) {
        viewModelScope.launch {
            repository.setMediaProfilePhoto(
                mediaFileId = mediaFile.id,
                entityType = mediaFile.entityTypeEnum,
                entityId = mediaFile.entityId,
            ).onSuccess {
                loadMedia(mediaFile.entityId, mediaFile.entityTypeEnum)
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    error = "Failed to set profile photo: ${error.message}"
                )
            }
        }
    }

    fun filterByMediaType(mediaType: MediaType?) {
        _uiState.value = _uiState.value.copy(selectedMediaType = mediaType)
    }

    fun deleteMediaFile(mediaFileId: String) {
        viewModelScope.launch {
            repository.deleteMediaFile(mediaFileId).onSuccess {
                // Remove from current list
                val updatedFiles = _uiState.value.mediaFiles.filter { it.id != mediaFileId }
                _uiState.value = _uiState.value.copy(mediaFiles = updatedFiles)
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    error = "Failed to delete media: ${error.message}"
                )
            }
        }
    }

    val filteredMedia: List<MediaFile>
        get() {
            val selectedType = _uiState.value.selectedMediaType
            return if (selectedType != null) {
                _uiState.value.mediaFiles.filter { it.fileType == selectedType }
            } else {
                _uiState.value.mediaFiles
            }
        }
}
