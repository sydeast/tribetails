package com.tribetails.auntieos.ui.media

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.GalleryFilter
import com.tribetails.auntieos.domain.filterGalleryMedia
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class GalleryUiState(
    val media: List<MediaFile> = emptyList(),
    val kin: List<Kin> = emptyList(),
    val kinfolk: List<Kinfolk> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
    /**
     * A refused ACTION (a delete the callable turned down), shown as a banner
     * above the grid. Kept apart from [error], which describes the LOAD:
     * blanking a working grid because one action was refused would hide the
     * very rows the operator needs to see to understand what happened. The
     * same split the web Gallery and MediaGalleryViewModel already make.
     */
    val actionError: String? = null,
    val filter: GalleryFilter = GalleryFilter(),
)

/**
 * #13 global Gallery: loads ALL business media + the kin/kinfolk catalogs (for the
 * household filter labels + the tag picker), holds the active filter, and writes
 * taggedKinIds. Fail-loud: a load/save error surfaces into uiState.error.
 */
class GalleryViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(GalleryUiState())
    val uiState: StateFlow<GalleryUiState> = _uiState.asStateFlow()

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val mediaR = repository.getAllMedia()
            val kinR = repository.getAllKin()
            val kinfolkR = repository.getKinfolk()
            mediaR.onSuccess { m ->
                _uiState.value = _uiState.value.copy(
                    media = m,
                    kin = kinR.getOrDefault(emptyList()),
                    kinfolk = kinfolkR.getOrDefault(emptyList()),
                    isLoading = false,
                )
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(isLoading = false, error = "Failed to load media: ${e.message}")
            }
        }
    }

    fun setFilter(f: GalleryFilter) {
        _uiState.value = _uiState.value.copy(filter = f)
    }
    fun clearActionError() {
        _uiState.value = _uiState.value.copy(actionError = null)
    }
    /**
     * Delete one file through the `deleteMediaFile` callable (#755, the
     * Android half of what the web Gallery has done since #692). NO `entityId`
     * scope is sent: this grid spans every household, so it has no scope to
     * assert; the entity-scoped MediaGalleryViewModel passes its row's own and
     * this one deliberately does not (see AuntieRepository.deleteMediaFile).
     *
     * Spliced out of state ONLY once the callable resolved: this screen loads
     * with a one-shot read rather than a live listener, so without the splice
     * the tile would stay until the next load and a real delete would read as a
     * no-op. A refusal leaves the row where it is and lands in [GalleryUiState.actionError].
     */
    fun deleteMedia(mediaId: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repository.deleteMediaFile(mediaId).onSuccess {
                _uiState.value = _uiState.value.copy(
                    media = _uiState.value.media.filter { it.id != mediaId },
                    actionError = null,
                )
                onDone(true)
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(actionError = "Deleting this file did not go through: ${e.message}")
                onDone(false)
            }
        }
    }

    /**
     * Persist taggedKinIds through the `saveMediaTags` callable (#447), then
     * reflect locally so the grid updates without a reload.
     *
     * What is reflected is the list the SERVER returned, not the list this
     * screen sent: the callable de-duplicates, so echoing the request back
     * would leave the grid showing a list the document does not hold.
     */
    fun saveTags(mediaId: String, kinIds: List<String>, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repository.updateMediaTags(mediaId, kinIds).onSuccess { stored ->
                _uiState.value = _uiState.value.copy(
                    media = _uiState.value.media.map { if (it.id == mediaId) it.copy(taggedKinIds = stored) else it },
                )
                onDone(true)
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(error = "Failed to save tags: ${e.message}")
                onDone(false)
            }
        }
    }

    val shown: List<MediaFile>
        get() = filterGalleryMedia(_uiState.value.media, _uiState.value.filter)
}
