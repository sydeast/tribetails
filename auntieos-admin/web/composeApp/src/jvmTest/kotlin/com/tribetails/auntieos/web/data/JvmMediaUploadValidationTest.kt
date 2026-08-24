package com.tribetails.auntieos.web.data

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotEquals

/**
 * #518: desktop's admin/operator profile-photo upload (`SettingsScreen.kt`'s
 * ProfilePanel) routes through `platformUploadMedia` -> [JvmMediaUpload.upload].
 * That pipeline talks to a live signed-upload endpoint + Cloudinary, so a full
 * successful-upload run cannot be exercised here without real network + a signed-in
 * Firebase session (no mock seam exists for it, unlike the Firestore doc reads/writes
 * `JvmFirestoreFixtures` fakes) - the same category of external-dependency limit as
 * needing a real secret. What IS unit-testable, and what this file pins down, are the
 * synchronous REJECTED-path guards that run before any network call: a blank entityId,
 * and [JvmMediaUpload.MAX_FILE_SIZE_BYTES] (added by #518 for parity with Android's
 * `CloudinaryConfig.MAX_FILE_SIZE` - desktop had a picker-level image-extension filter
 * but no byte-size cap at all before this).
 */
class JvmMediaUploadValidationTest {

    @Test
    fun `blank entityId is rejected before any network call`() = runTest {
        val result = JvmMediaUpload.upload(
            entityId = "",
            entityType = "USER",
            bytes = byteArrayOf(1, 2, 3),
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertEquals("uploadMedia requires a non-blank entityId", err.message)
    }

    @Test
    fun `a file over the size cap is rejected before any network call`() = runTest {
        val oversized = ByteArray((JvmMediaUpload.MAX_FILE_SIZE_BYTES + 1).toInt())
        val result = JvmMediaUpload.upload(
            entityId = "operator-uid",
            entityType = "USER",
            bytes = oversized,
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertEquals(
            "Selected media exceeds the ${JvmMediaUpload.MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit",
            err.message,
        )
    }

    @Test
    fun `a file at exactly the size cap is NOT rejected on size`() = runTest {
        // Proves the cap is size > MAX, not size >= MAX (an off-by-one would reject
        // the boundary file too). This still fails past the size check - a plain
        // unit test has no live network/Firebase session - but whatever it fails
        // with must NOT be the size-limit message, which is the one thing that
        // would prove the size gate itself rejected a boundary-legal file. (Not
        // pinned to the exact downstream message: this JVM may or may not have a
        // persisted Firebase session depending on the machine it runs on, so the
        // failure could be "sign-in required" or a network error - either is fine,
        // only the size message would be a real failure here.)
        val atLimit = ByteArray(JvmMediaUpload.MAX_FILE_SIZE_BYTES.toInt())
        val result = JvmMediaUpload.upload(
            entityId = "operator-uid",
            entityType = "USER",
            bytes = atLimit,
            mimeType = "image/jpeg",
        )
        val err = assertIs<WriteResult.Err>(result)
        assertNotEquals(
            "Selected media exceeds the ${JvmMediaUpload.MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit",
            err.message,
        )
    }
}
