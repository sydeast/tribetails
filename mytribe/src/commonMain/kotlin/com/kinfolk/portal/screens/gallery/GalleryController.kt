package com.kinfolk.portal.screens.gallery

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.kinfolk.portal.portal.KinPhoto
import com.kinfolk.portal.portal.KinPortrait
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Tales read per page. Photos returned is whatever those tales carry. */
const val GALLERY_PAGE_SIZE = 12

/**
 * State holder for the Gallery screen (#469, matching the web portal's
 * `Gallery.tsx` from PR #436). Reads `getMyKinPhotos` a page at a time and
 * appends, on the same pattern as InvoicesController and
 * MessageAuntieController.
 *
 * A first-page failure and a next-page failure are kept apart on purpose. The
 * first blanks the screen, because there is nothing to show; the second leaves
 * the photos already on screen alone and puts the problem beside the button
 * that caused it, so a household does not lose its place to a flaky page.
 *
 * A refusal is its own state rather than one more "couldn't load" line. An
 * account looking at a family it is not part of is not a network blip, and
 * telling it to retry would be a lie.
 */
class GalleryController internal constructor(
    private val kinfolkId: String,
    private val portalApi: PortalApi,
    private val scope: CoroutineScope,
) {
    /** null = not loaded yet; empty list = loaded, no photos in the archive. */
    var photos by mutableStateOf<List<KinPhoto>?>(null)
        private set

    /** Current Kin portraits. The server sends these on the first page only. */
    var portraits by mutableStateOf<List<KinPortrait>>(emptyList())
        private set

    /** First-page failure only, and never a refusal (see [accessDenied]). */
    var loadError by mutableStateOf<String?>(null)
        private set

    /** True when the server refused this household's photos outright. */
    var accessDenied by mutableStateOf(false)
        private set

    /** True while there is an older page to ask for. */
    var hasMore by mutableStateOf(false)
        private set

    var loadingMore by mutableStateOf(false)
        private set

    /** Next-page failure only. The photos already read stay on screen. */
    var moreError by mutableStateOf<String?>(null)
        private set

    /** The cursor for the next page: the last tale's sent time. */
    private var nextBefore: Long? = null

    /** The photo the viewer is open on, or null when it is closed. */
    var viewing by mutableStateOf<KinPhoto?>(null)
        private set

    suspend fun reload() {
        try {
            val page = portalApi.getMyKinPhotos(kinfolkId = kinfolkId, limit = GALLERY_PAGE_SIZE)
            photos = page.photos
            portraits = page.portraits
            // The server pages by tale, so it can hand back a page of tales
            // that carried no pictures at all and still have more behind it.
            // `hasMore` is its answer, not a count of what arrived here.
            hasMore = page.hasMore && page.nextBefore != null
            nextBefore = page.nextBefore
            loadError = null
            accessDenied = false
            moreError = null
        } catch (t: Throwable) {
            photos = null
            portraits = emptyList()
            hasMore = false
            nextBefore = null
            if (isPermissionDenied(t.message)) {
                accessDenied = true
                loadError = null
            } else {
                accessDenied = false
                loadError = t.message ?: "Could not load your photos."
            }
        }
    }

    /**
     * Reads the next older page and appends it. No-op when there is nothing
     * older or a page is already in flight, so a double tap cannot append the
     * same photos twice.
     */
    fun loadMore() {
        val cursor = nextBefore
        if (!hasMore || loadingMore || cursor == null) return
        loadingMore = true
        moreError = null
        scope.launch {
            try {
                val page = portalApi.getMyKinPhotos(
                    kinfolkId = kinfolkId,
                    limit = GALLERY_PAGE_SIZE,
                    before = cursor,
                )
                // The same media file can be attached to two tales. The server
                // dedupes within a page; across pages this is the guard.
                val seen = photos.orEmpty().map { it.id }.toSet()
                photos = photos.orEmpty() + page.photos.filterNot { seen.contains(it.id) }
                hasMore = page.hasMore && page.nextBefore != null
                nextBefore = page.nextBefore
            } catch (t: Throwable) {
                moreError = t.message ?: "Could not load older photos."
            } finally {
                loadingMore = false
            }
        }
    }

    fun openViewer(photo: KinPhoto) {
        viewing = photo
    }

    fun closeViewer() {
        viewing = null
    }
}

@Composable
fun rememberGalleryController(kinfolkId: String, portalApi: PortalApi): GalleryController {
    val scope = rememberCoroutineScope()
    return remember(kinfolkId, portalApi) { GalleryController(kinfolkId, portalApi, scope) }
}

/**
 * True when a thrown message reads as the server refusing the caller rather
 * than failing.
 *
 * Callable errors reach this client as a message string, so this matches on
 * the code the Functions SDK puts there. Same approach, and the same reason,
 * as `isEmailUnverified` in ClaimFlow.kt: a refusal is a fact to state, not a
 * failure to retry.
 */
fun isPermissionDenied(message: String?): Boolean {
    val m = message?.lowercase() ?: return false
    return "permission-denied" in m || "permission_denied" in m || "permission denied" in m
}
