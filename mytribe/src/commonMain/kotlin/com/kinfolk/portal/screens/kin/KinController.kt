package com.kinfolk.portal.screens.kin

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.kinfolk.portal.portal.BreedsResult
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinResult
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.PortalApi
import kotlin.coroutines.cancellation.CancellationException

/**
 * Shared Kin state holder. The list screen, the lifted KinDetailRoute, and the
 * KinAddEditRoute dialog all read the same controller so reload (after add /
 * edit / archive) refreshes a single source of truth across nav destinations.
 */
class KinController internal constructor(
    private val kinfolkId: String,
    private val portalApi: PortalApi,
    private val scope: kotlinx.coroutines.CoroutineScope,
) {
    var data by mutableStateOf<KinResult?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var schema by mutableStateOf<FormSchema?>(null)
        private set

    /** Dog + cat breed lists for the add/edit breed dropdown. Empty until loaded. */
    var breeds by mutableStateOf(BreedsResult(emptyList(), emptyList()))
        private set

    /**
     * Photo-upload outcome, separate from [error]: the kin write itself
     * succeeded, so the list still renders; the screen shows this as a
     * dismissible banner instead of the full-screen error state.
     */
    var photoNotice by mutableStateOf<String?>(null)

    /** True while a picked photo is uploading after add/update. */
    var photoUploading by mutableStateOf(false)
        private set

    fun find(kinId: String): Kin? = data?.kin?.firstOrNull { it.id == kinId }

    suspend fun reload() {
        try {
            data = portalApi.getMyKin(kinfolkId)
            error = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            error = t.message ?: "Could not load Kin"
        }
    }

    suspend fun loadSchema() {
        // Best-effort schema load. Fall back silently to static fields if missing.
        try {
            schema = portalApi.getFormSchema("kinProfile")
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) { /* admin has not set up schema yet, keep static fields */ }
    }

    /** Best-effort breed-list load for the Dog/Cat breed dropdown. Falls back
     *  to a free-text breed field if the call fails or banks are empty. */
    suspend fun loadBreeds() {
        try {
            breeds = portalApi.getBreeds()
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) { /* keep empty; breed stays free text */ }
    }

    /**
     * Add a Kin, upload its photo, and reload the list — all awaited so the
     * caller can keep the dialog open and surface a real error on failure.
     * Returns null on success, or a human-readable error message. NEVER
     * fire-and-forget: a silently dropped add is exactly the bug that made
     * a newly added Kin vanish (the cold-started addKin call was abandoned
     * the instant the dialog popped, before the write committed).
     */
    suspend fun addAndReload(payload: KinPayload, photo: com.kinfolk.portal.media.PickedImage? = null): String? =
        try {
            val kinId = portalApi.addKin(kinfolkId = kinfolkId, kin = payload)
            photo?.let { uploadPhoto(kinId, it) }
            reload()
            error = null
            null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            t.message ?: "Could not add Kin"
        }

    /**
     * Edit an existing Kin and reload. Returns null on success, or an error
     * message. [photo] (#1291) runs after the text write: an upload is
     * best-effort (see [uploadPhoto]); a removal failing IS a save failure,
     * since nothing else would tell the household the photo is still there.
     */
    suspend fun updateAndReload(kinId: String, payload: KinPayload, photo: KinPhotoChange = KinPhotoChange.Keep): String? =
        try {
            portalApi.updateKin(kinfolkId = kinfolkId, kinId = kinId, kin = payload)
            when (photo) {
                is KinPhotoChange.Upload -> uploadPhoto(kinId, photo.image)
                KinPhotoChange.Remove -> {
                    portalApi.removeKinPhoto(kinfolkId = kinfolkId, kinId = kinId)
                    photoNotice = null
                }
                KinPhotoChange.Keep -> Unit
            }
            reload()
            error = null
            null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            t.message ?: "Could not save Kin"
        }

    /**
     * Best-effort photo upload after a successful kin write. Failure never
     * fails the save — the kin doc exists either way — it surfaces a
     * [photoNotice] so the user knows to retry from Edit. Signed
     * direct-to-Cloudinary (see [PortalApi.uploadKinPhotoSigned]) — replaces
     * the old base64-through-the-callable path and its 2MB cap.
     */
    private suspend fun uploadPhoto(kinId: String, photo: com.kinfolk.portal.media.PickedImage) {
        photoUploading = true
        try {
            portalApi.uploadKinPhotoSigned(kinfolkId = kinfolkId, kinId = kinId, image = photo)
            photoNotice = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            photoNotice = "Kin saved, but the photo didn't upload (${t.message ?: "network error"}). Try again from Edit."
        } finally {
            photoUploading = false
        }
    }

    /**
     * Mark a Kin no longer with us ([restore] false) or bring it back (true),
     * then reload so the list regroups. Returns null on success, else the
     * message for the dialog to show inline (#1311). Same shape as
     * [updateAndReload]: a failure here is the dialog's to report, not the
     * list's full-screen error state.
     */
    suspend fun archiveAndReload(kinId: String, restore: Boolean): String? =
        try {
            portalApi.archiveKin(kinfolkId = kinfolkId, kinId = kinId, restore = restore)
            reload()
            null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            t.message ?: "Could not save this change"
        }
}

@Composable
fun rememberKinController(kinfolkId: String, portalApi: PortalApi): KinController {
    val scope = rememberCoroutineScope()
    return remember(kinfolkId, portalApi) { KinController(kinfolkId, portalApi, scope) }
}
