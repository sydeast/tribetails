package com.tribetails.auntieos.ui.media

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.media.BatchMediaUploadResult
import com.tribetails.auntieos.media.MediaUploadManager
import kotlinx.coroutines.launch

class MediaUploadViewModel(
    private val mediaUploadManager: MediaUploadManager = AuntieOSApp.instance.mediaUploadManager
) : ViewModel() {
    // This ViewModel is intentionally owned by MediaGalleryScreen and passed into
    // MediaPickerDialog so upload state and callbacks stay scoped to the media UI.

    /**
     * Uploads all [uris] and delivers a [BatchMediaUploadResult] via [onComplete].
     * Partial success is preserved: [BatchMediaUploadResult.succeeded] is always
     * non-null and callers must surface [BatchMediaUploadResult.failed] to the user
     * when it is non-empty (fail-loud — never silently discard failures).
     */
    fun uploadMedia(
        uris: List<Uri>,
        entityId: String,
        entityType: MediaEntityType,
        description: String = "",
        tags: List<String> = emptyList(),
        onProgress: (Float) -> Unit = {},
        onComplete: (Result<BatchMediaUploadResult>) -> Unit
    ) {
        viewModelScope.launch {
            try {
                val totalFiles = uris.size
                var completedFiles = 0

                // Upload each file individually so we can track per-file progress,
                // then delegate to uploadMultipleMedia for the structured result.
                // Re-use the manager's own sequential logic via the batch overload,
                // but wrap progress reporting around it.
                val succeeded = mutableListOf<MediaFile>()
                val failed = mutableListOf<Pair<Uri, String>>()

                for (uri in uris) {
                    val result = mediaUploadManager.uploadMedia(
                        uri = uri,
                        entityId = entityId,
                        entityType = entityType,
                        description = description,
                        tags = tags,
                        onProgress = { uploadProgress ->
                            val overallProgress = (completedFiles + uploadProgress.percentage / 100f) / totalFiles
                            onProgress(overallProgress)
                        }
                    )
                    result.fold(
                        onSuccess = { mediaFile ->
                            succeeded.add(mediaFile)
                            completedFiles++
                            onProgress(completedFiles.toFloat() / totalFiles)
                        },
                        onFailure = { error ->
                            failed.add(uri to (error.message ?: "Unknown error"))
                            completedFiles++
                            onProgress(completedFiles.toFloat() / totalFiles)
                        }
                    )
                }

                onComplete(Result.success(BatchMediaUploadResult(succeeded = succeeded, failed = failed)))

            } catch (e: Exception) {
                onComplete(Result.failure(e))
            }
        }
    }

    fun uploadSingleMedia(
        uri: Uri,
        entityId: String,
        entityType: MediaEntityType,
        description: String = "",
        tags: List<String> = emptyList(),
        onProgress: (Float) -> Unit = {},
        onComplete: (Result<MediaFile>) -> Unit
    ) {
        viewModelScope.launch {
            val result = mediaUploadManager.uploadMedia(
                uri = uri,
                entityId = entityId,
                entityType = entityType,
                description = description,
                tags = tags,
                onProgress = { uploadProgress ->
                    onProgress(uploadProgress.percentage / 100f)
                }
            )
            onComplete(result)
        }
    }
}
