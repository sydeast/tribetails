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

    /** Persist taggedKinIds, then reflect locally so the grid updates without a reload. */
    fun saveTags(mediaId: String, kinIds: List<String>, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repository.updateMediaTags(mediaId, kinIds).onSuccess {
                _uiState.value = _uiState.value.copy(
                    media = _uiState.value.media.map { if (it.id == mediaId) it.copy(taggedKinIds = kinIds) else it },
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
