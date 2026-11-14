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
import com.kinfolk.portal.portal.KinVet
import com.kinfolk.portal.portal.VetClinic
import com.kinfolk.portal.portal.VetClinicSummary
import com.kinfolk.portal.portal.resolveKinVet
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.KinRemovalOptions
import com.kinfolk.portal.portal.KinRemovalRequest
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
    /** #1504: the API the add/edit dialog's warm-on-open call goes through. */
    internal val api: PortalApi get() = portalApi
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
    /**
     * #1908 kin-vet: the household's vet (from the Tribe Profile) and the area
     * vet list, for the Kin vet line and its "Different vet for this Kin"
     * dropdown. [vetsLoaded] false until the first [loadVets] finishes, so the
     * dialog can show the wait; [vetsError] says when the list would not load.
     */
    var householdVet by mutableStateOf<VetClinicSummary?>(null)
        private set
    var vetClinics by mutableStateOf<List<VetClinic>>(emptyList())
        private set
    var vetsLoaded by mutableStateOf(false)
        private set
    var vetsError by mutableStateOf<String?>(null)
        private set
    /** The vet [kin] goes to, for display ([resolveKinVet]). */
    fun vetFor(kin: Kin): KinVet? = resolveKinVet(kin, householdVet, vetClinics)
    /** Loads the household vet and the area list. Either can fail without failing the other. */
    suspend fun loadVets() {
        var problem: String? = null
        try {
            vetClinics = portalApi.getVetClinics()
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            problem = "Could not load the vet list: ${t.message ?: "try again later"}"
        }
        try {
            householdVet = portalApi.getMyTribeProfile(kinfolkId).vetClinic
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            problem = problem ?: "Could not load your Tribe Profile vet: ${t.message ?: "try again later"}"
        }
        vetsError = problem
        vetsLoaded = true
    }

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

    /**
     * #1314 / #1408. What the edit dialog may offer for removing this Kin: the
     * delete row (nothing on file) or the removal request (history), with any
     * request already made. Throws on failure so the dialog can say the check
     * failed and offer a retry rather than guessing.
     */
    suspend fun kinRemovalOptions(kinId: String): KinRemovalOptions =
        portalApi.kinRemovalOptions(kinfolkId = kinfolkId, kinId = kinId)

    /**
     * #1408. Ask the office to remove a Kin with history. Success carries the
     * recorded request for the dialog's pending state; failure carries the
     * server's sentence to show inline. The roster does not change.
     */
    suspend fun requestRemoval(kinId: String, reason: String): Result<KinRemovalRequest> =
        try {
            Result.success(portalApi.requestKinRemoval(kinfolkId = kinfolkId, kinId = kinId, reason = reason))
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            Result.failure(IllegalStateException(t.message ?: "Could not send the request", t))
        }

    /**
     * #1314. Delete a Kin with no history, then reload so the list drops it.
     * Returns null on success, else the message for the dialog to show inline
     * (the server's refusal sentence when history appeared in the meantime).
     */
    suspend fun deleteAndReload(kinId: String): String? =
        try {
            portalApi.deleteKin(kinfolkId = kinfolkId, kinId = kinId)
            reload()
            null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            t.message ?: "Could not delete this Kin"
        }
}

@Composable
fun rememberKinController(kinfolkId: String, portalApi: PortalApi): KinController {
    val scope = rememberCoroutineScope()
    return remember(kinfolkId, portalApi) { KinController(kinfolkId, portalApi, scope) }
}
