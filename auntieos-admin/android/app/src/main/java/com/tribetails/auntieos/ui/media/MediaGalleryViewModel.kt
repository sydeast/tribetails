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

    /**
     * #397 S2: deletes through the server-bound callable, passing the ROW's own
     * entityId as the scope cross-check so a stale id from one household can
     * never delete another's media. Takes the whole [mediaFile] for exactly that
     * reason, where it used to take a bare id.
     */
    fun deleteMediaFile(mediaFile: MediaFile) {
        viewModelScope.launch {
            repository.deleteMediaFile(mediaFile.id, mediaFile.entityId).onSuccess {
                // Safe to splice ONLY because the callable resolved: the document
                // is genuinely gone, not presumed gone.
                val updatedFiles = _uiState.value.mediaFiles.filter { it.id != mediaFile.id }
                _uiState.value = _uiState.value.copy(mediaFiles = updatedFiles)
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    error = "Failed to delete media: ${error.message}"
                )
            }
        }
    }

    /**
     * #397 S3: rewrites one file's caption. Neither client could do this before;
     * `description` was written once, at upload, and never again.
     *
     * On success the row in state is patched with `copy(description = ...)`
     * ONE field on the model that was LOADED, never a model rebuilt from what the
     * editor happened to show. This screen loads with a one-shot `getMediaFiles`
     * rather than a live listener, so without the patch the grid would keep
     * showing the old caption until the next load and a real save would read as
     * a no-op.
     *
     * An empty caption is a real value: it CLEARS the description, and the tile
     * falls back to the file name, same as a file that was never captioned.
     */
    fun updateCaption(mediaFileId: String, description: String) {
        viewModelScope.launch {
            repository.updateMediaFileDescription(mediaFileId, description).onSuccess {
                val trimmed = description.trim()
                val updatedFiles = _uiState.value.mediaFiles.map {
                    if (it.id == mediaFileId) it.copy(description = trimmed) else it
                }
                _uiState.value = _uiState.value.copy(mediaFiles = updatedFiles, error = null)
            }.onFailure { error ->
                // Fail loud, and leave the STORED caption on screen: a refused
                // save must never look like it landed.
                _uiState.value = _uiState.value.copy(
                    error = "Failed to save caption: ${error.message}"
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
