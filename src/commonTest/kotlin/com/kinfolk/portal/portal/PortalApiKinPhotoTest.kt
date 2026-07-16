package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.media.KinPhotoPolicy
import com.kinfolk.portal.media.PickedImage
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Signed direct-to-Cloudinary kin photo uploads (replaces the old
 * base64-through-`uploadKinPhoto` path and its 2MB cap). `uploadKinPhotoSigned`
 * itself calls the `uploadImageToCloudinary` expect/actual, whose jvmTest
 * actual is a hardcoded stub returning null (no real HTTP in unit tests, same
 * as every other platform's avatar-upload equivalent — untested end-to-end
 * here for the same structural reason) — so this file covers what's actually
 * testable: the two callable wrappers, and validation short-circuiting
 * before any network call.
 */
class PortalApiKinPhotoTest {

    private fun image(
        bytes: ByteArray = byteArrayOf(10, 20, 30, 40),
        mime: String = "image/jpeg",
        name: String = "bud.jpg",
    ) = PickedImage(bytes = bytes, mimeType = mime, fileName = name)

    @Test
    fun signKinPhotoUpload_sendsKinIdAndDecodesSignature() = runTest {
        val fns = FakeFunctionsClient()
        fns.stub("signKinPhotoUpload", buildJsonObject {
            put("cloudName", "demo"); put("apiKey", "key123"); put("timestamp", 1700000000L)
            put("signature", "abc123"); put("folder", "tribetails/kinfolks/3/kin/k1")
        })
        val api = PortalApi(fns)
        val signed = api.signKinPhotoUpload(kinId = "k1", kinfolkId = "3")

        assertEquals("demo", signed.cloudName)
        assertEquals("key123", signed.apiKey)
        assertEquals(1700000000L, signed.timestamp)
        assertEquals("abc123", signed.signature)
        assertEquals("tribetails/kinfolks/3/kin/k1", signed.folder)

        val payload = fns.calls.single().second!!
        assertEquals("k1", payload["kinId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("3", payload["kinfolkId"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun signKinPhotoUpload_omitsKinfolkId_whenNull() = runTest {
        val fns = FakeFunctionsClient()
        fns.stub("signKinPhotoUpload", buildJsonObject { put("cloudName", "demo") })
        val api = PortalApi(fns)
        api.signKinPhotoUpload(kinId = "k1")
        val payload = fns.calls.single().second!!
        assertEquals(null, payload["kinfolkId"])
    }

    @Test
    fun confirmKinPhotoUpload_sendsSecureUrlAndReturnsPhotoUrl() = runTest {
        val fns = FakeFunctionsClient()
        val url = "https://res.cloudinary.com/demo/image/upload/v1/tribetails/kinfolks/3/kin/k1/photo.jpg"
        fns.stub("confirmKinPhotoUpload", buildJsonObject { put("photoUrl", url) })
        val api = PortalApi(fns)

        val result = api.confirmKinPhotoUpload(kinId = "k1", secureUrl = url, kinfolkId = "3")

        assertEquals(url, result)
        val payload = fns.calls.single().second!!
        assertEquals("k1", payload["kinId"]?.jsonPrimitive?.contentOrNull)
        assertEquals(url, payload["secureUrl"]?.jsonPrimitive?.contentOrNull)
        assertEquals("3", payload["kinfolkId"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun confirmKinPhotoUpload_failsLoudWhenResponseMissesPhotoUrl() = runTest {
        val fns = FakeFunctionsClient()
        fns.stub("confirmKinPhotoUpload", buildJsonObject { put("ok", true) })
        val api = PortalApi(fns)
        assertFailsWith<IllegalStateException> {
            api.confirmKinPhotoUpload(kinId = "k1", secureUrl = "https://res.cloudinary.com/demo/image/upload/x.jpg")
        }
    }

    @Test
    fun confirmKinPhotoUpload_propagatesCallableErrors() = runTest {
        val fns = FakeFunctionsClient()
        fns.stubError("confirmKinPhotoUpload", RuntimeException("invalid-argument"))
        val api = PortalApi(fns)
        val failure = assertFailsWith<RuntimeException> {
            api.confirmKinPhotoUpload(kinId = "k1", secureUrl = "https://res.cloudinary.com/demo/image/upload/x.jpg")
        }
        assertEquals("invalid-argument", failure.message)
    }

    @Test
    fun uploadKinPhotoSigned_rejectsOversizeBeforeCallingSign() = runTest {
        val fns = FakeFunctionsClient()
        val api = PortalApi(fns)
        val failure = assertFailsWith<IllegalStateException> {
            api.uploadKinPhotoSigned(kinId = "k1", image = image(bytes = ByteArray(KinPhotoPolicy.MAX_BYTES + 1)))
        }
        // Pins the user-facing message text to the actual cap (10MB) — this
        // regressed once already (message said "2MB" after the cap was
        // raised to 10MB) because nothing asserted the string itself.
        assertTrue(failure.message!!.contains("10MB"), "expected a 10MB message, got: ${failure.message}")
        assertTrue(fns.calls.isEmpty(), "oversize image must never reach the network")
    }

    @Test
    fun uploadKinPhotoSigned_rejectsBadMimeBeforeCallingSign() = runTest {
        val fns = FakeFunctionsClient()
        val api = PortalApi(fns)
        assertFailsWith<IllegalStateException> {
            api.uploadKinPhotoSigned(kinId = "k1", image = image(mime = "application/pdf"))
        }
        assertTrue(fns.calls.isEmpty())
    }

    @Test
    fun uploadKinPhotoSigned_surfacesAFriendlyError_whenCloudinaryIsNotConfigured() = runTest {
        val fns = FakeFunctionsClient()
        // A blank cloudName is exactly what signKinPhotoUploadHandler returns
        // if it somehow got past its own failed-precondition throw — belt and
        // suspenders on the client side too.
        fns.stub("signKinPhotoUpload", buildJsonObject { put("cloudName", "") })
        val api = PortalApi(fns)
        val failure = assertFailsWith<IllegalStateException> {
            api.uploadKinPhotoSigned(kinId = "k1", image = image())
        }
        assertNotNull(failure.message)
        assertTrue(failure.message!!.contains("available"))
    }
}
