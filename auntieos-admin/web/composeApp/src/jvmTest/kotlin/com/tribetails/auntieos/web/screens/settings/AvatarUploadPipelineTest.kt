package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #518: [runAvatarUploadPipeline] is the testable core [ProfilePanel] extracted from
 * its avatar/camera-badge + "Edit photo" upload trigger, specifically so this file
 * can drive a full SUCCESSFUL upload and every REJECTED path with fake upload/stamp
 * lambdas - no live FirestoreClient, no network, no Cloudinary account. (A true
 * end-to-end network test against the real signed-upload + Cloudinary endpoints is
 * not runnable in this environment - no seam exists to fake that live third-party
 * call, the same class of limit as needing a real external credential - so this is
 * the deepest layer of the real pipeline unit-testable without one; see
 * [JvmMediaUploadValidationTest] for JvmMediaUpload's own synchronous guards.)
 */
class AvatarUploadPipelineTest {

    private fun photo(id: String = "media-1", url: String = "https://res.cloudinary.com/demo/image/upload/avatar.jpg") =
        MediaFile(_id = id, storageUrl = url)

    @Test
    fun `successful upload stamps the photo, fires the audit, and toasts success`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        var auditFired = false
        val uploaded = photo()

        runAvatarUploadPipeline(
            upload = { WriteResult.Ok(uploaded) },
            stamp = { mediaId -> assertEquals(uploaded._id, mediaId); WriteResult.Ok(Unit) },
            onPhotoUrl = { photoUrl = it },
            onToast = { toast = it },
            onAuditSuccess = { auditFired = true },
        )

        assertEquals(uploaded.storageUrl, photoUrl)
        assertTrue(auditFired, "a successful upload must fire the audit trail")
        assertEquals("Profile photo updated" to ToastKind.Success, toast)
    }

    @Test
    fun `rejected upload never fakes a success`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        var auditFired = false

        runAvatarUploadPipeline(
            upload = { WriteResult.Err("Selected media exceeds the 50MB limit") },
            stamp = { WriteResult.Ok(Unit) },
            onPhotoUrl = { photoUrl = it },
            onToast = { toast = it },
            onAuditSuccess = { auditFired = true },
        )

        assertEquals(null, photoUrl)
        assertTrue(!auditFired, "a rejected upload must never fire the audit trail")
        assertEquals("Photo upload failed: Selected media exceeds the 50MB limit" to ToastKind.Error, toast)
    }

    @Test
    fun `a cancelled picker (blank id or url) is rejected, not faked as a save`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        var stampCalled = false

        runAvatarUploadPipeline(
            upload = { WriteResult.Ok(MediaFile(_id = "", storageUrl = "")) },
            stamp = { stampCalled = true; WriteResult.Ok(Unit) },
            onPhotoUrl = { photoUrl = it },
            onToast = { toast = it },
            onAuditSuccess = {},
        )

        assertEquals(null, photoUrl)
        assertTrue(!stampCalled, "a cancelled/empty picker result must never reach the stamp call")
        assertEquals("No photo selected" to ToastKind.Error, toast)
    }

    @Test
    fun `upload OK but the profile stamp fails - the two-stage fail-loud case`() = runTest {
        var photoUrl: String? = null
        var toast: Pair<String, ToastKind>? = null
        val uploaded = photo()

        runAvatarUploadPipeline(
            upload = { WriteResult.Ok(uploaded) },
            stamp = { WriteResult.Err("network unreachable") },
            onPhotoUrl = { photoUrl = it },
            onToast = { toast = it },
            onAuditSuccess = {},
        )

        assertEquals(null, photoUrl)
        assertEquals("Photo uploaded but profile save failed: network unreachable" to ToastKind.Error, toast)
    }
}
