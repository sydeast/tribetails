package com.tribetails.auntieos.web.screens.media

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ISSUE #577: the desktop admin's media delete goes through the `deleteMediaFile`
 * CALLABLE, not a client write to `media_files`.
 *
 * WHAT THIS GUARDS. The jvm actual used to be
 * `patchFields("media_files", id, {"deleted": true})`, a client update writing a
 * soft-delete flag nothing in the repo reads, so the row survived and so did the
 * tile. A raw document delete would have been worse: `setMediaProfilePhoto`
 * stamps `kinfolk`/`kin.profilePictureUrl` (or `users.photoUrl`) with the media
 * doc's own `storageUrl`, so dropping the row alone strands a profile rendering a
 * photo the gallery has forgotten. Only the callable holds both writes, and only
 * the callable writes the MEDIA_FILE_DELETED audit entry.
 *
 * `FirestoreClient.deleteMedia` routes through `platformInvokeCallable`, which the
 * jvm actual answers from `JvmFirestoreFixtures.callableResponses` while recording
 * the name and payload it was handed. jvm IS the desktop target (#513 retired
 * wasm), so asserting on that capture is asserting on the shipped desktop path:
 * with no fixture set the same call reaches the real callable over REST.
 */
class MediaDeleteClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.clear() }

    @Test
    fun deleteRoutesThroughTheCallableWithTheEntityScopeCrossCheck() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "deleteMediaFile" to
                """{"ok":true,"mediaFileId":"m1","entityType":"KINFOLK","entityId":"kf1","clearedProfilePhoto":true}""",
        )

        val r = FirestoreClient().deleteMedia("m1", "kf1")

        assertTrue(r is WriteResult.Ok, "expected Ok, got $r")
        assertEquals("deleteMediaFile", JvmFirestoreFixtures.lastCallableName)
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"mediaFileId\":\"m1\""), "payload was $payload")
        assertTrue(payload.contains("\"entityId\":\"kf1\""), "payload was $payload")
    }

    /**
     * The unscoped caller (the all-business gallery) OMITS `entityId` rather than
     * padding it blank: the server's own `min(1)` would refuse a blank string, so
     * a padded key would turn every unscoped delete into an invalid-argument.
     */
    @Test
    fun blankEntityIdIsOmittedFromThePayloadRatherThanSentEmpty() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("deleteMediaFile" to """{"ok":true}""")

        val r = FirestoreClient().deleteMedia("m2")

        assertTrue(r is WriteResult.Ok, "expected Ok, got $r")
        assertEquals("deleteMediaFile", JvmFirestoreFixtures.lastCallableName)
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"mediaFileId\":\"m2\""), "payload was $payload")
        assertFalse(payload.contains("entityId"), "payload was $payload")
    }

    /** The KinTale attachment remove is the same callable, scoped by the session id. */
    @Test
    fun kinTaleAttachmentRemoveUsesTheSameCallable() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("deleteMediaFile" to """{"ok":true}""")

        val r = FirestoreClient().deleteKinTaleMedia("m3", "sess-9")

        assertTrue(r is WriteResult.Ok, "expected Ok, got $r")
        assertEquals("deleteMediaFile", JvmFirestoreFixtures.lastCallableName)
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"mediaFileId\":\"m3\""), "payload was $payload")
        assertTrue(payload.contains("\"entityId\":\"sess-9\""), "payload was $payload")
    }

    // A SERVER REFUSAL (wrong entity, missing doc, no admin claim) is not covered
    // here on purpose: with no fixture for the name, platformInvokeCallable falls
    // through to the real REST call, and a unit test must not reach production.
    // That the Err reaches the operator is pinned in commonTest instead, by
    // MediaGalleryViewModelTest.deleteMedia_failure_sets_error_state.

    /** A blank id never reaches the network: nothing on the server can act on it. */
    @Test
    fun aBlankMediaIdIsRefusedBeforeAnyCallable() = runBlocking {
        val r = FirestoreClient().deleteMedia("   ")

        assertTrue(r is WriteResult.Err, "expected Err, got $r")
        assertEquals(null, JvmFirestoreFixtures.lastCallableName)
    }
}
