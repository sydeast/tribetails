package com.kinfolk.portal.screens.kin

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.media.PickedImage
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1291. The Android (and Compose web) kin dialog's photo controls: pick,
 * replace, and remove, and how the controller turns each into server calls.
 */
class KinPhotoChangeTest {

    private val image = PickedImage(bytes = byteArrayOf(1, 2, 3), mimeType = "image/jpeg", fileName = "rex.jpg")

    @Test
    fun of_pickedPhotoWinsOverAnEarlierRemove() {
        assertEquals(KinPhotoChange.Upload(image), KinPhotoChange.of(image, removeRequested = true))
        assertEquals(KinPhotoChange.Upload(image), KinPhotoChange.of(image, removeRequested = false))
    }

    @Test
    fun of_removeWithoutAPickIsRemove_andNothingIsKeep() {
        assertEquals(KinPhotoChange.Remove, KinPhotoChange.of(null, removeRequested = true))
        assertEquals(KinPhotoChange.Keep, KinPhotoChange.of(null, removeRequested = false))
    }

    @Test
    fun removeKinPhoto_sendsAnExplicitNullPhotoUrlAndNoOtherField() = runTest {
        val fns = FakeFunctionsClient()
        fns.stub("updateKin", buildJsonObject { put("ok", true) })
        PortalApi(fns).removeKinPhoto(kinfolkId = "fam1", kinId = "k1")

        val (name, payload) = fns.calls.single()
        assertEquals("updateKin", name)
        val kin = payload!!["kin"]!!.jsonObject
        assertEquals(setOf("photoUrl"), kin.keys)
        assertEquals(JsonNull, kin["photoUrl"])
    }

    private fun controller(fns: FakeFunctionsClient, scope: TestScope) =
        KinController("fam1", PortalApi(fns), scope)

    private fun stubSaves(fns: FakeFunctionsClient) {
        fns.stub("updateKin", buildJsonObject { put("ok", true) })
        fns.stub("getMyKin", buildJsonObject { put("kin", buildJsonArray { }) })
    }

    @Test
    fun updateAndReload_remove_writesTheTextThenClearsThePhoto() = runTest {
        val fns = FakeFunctionsClient()
        stubSaves(fns)
        val err = controller(fns, this).updateAndReload("k1", KinPayload(name = "Rex"), KinPhotoChange.Remove)

        assertNull(err)
        val updates = fns.calls.filter { it.first == "updateKin" }.map { it.second!!["kin"]!!.jsonObject }
        assertEquals(2, updates.size)
        // The text save never carries photoUrl (null fields are dropped)...
        assertFalse(updates[0].containsKey("photoUrl"))
        // ...and the removal is its own explicit null.
        assertEquals(JsonNull, updates[1]["photoUrl"])
        assertFalse(fns.calls.any { it.first == "signKinPhotoUpload" })
    }

    @Test
    fun updateAndReload_keep_neverTouchesThePhoto() = runTest {
        val fns = FakeFunctionsClient()
        stubSaves(fns)
        controller(fns, this).updateAndReload("k1", KinPayload(name = "Rex"), KinPhotoChange.Keep)

        val updates = fns.calls.filter { it.first == "updateKin" }
        assertEquals(1, updates.size)
        assertFalse(updates.single().second!!["kin"]!!.jsonObject.containsKey("photoUrl"))
        assertFalse(fns.calls.any { it.first == "signKinPhotoUpload" })
    }

    @Test
    fun updateAndReload_upload_signsForThisKin_andAFailedUploadIsANoticeNotASaveError() = runTest {
        val fns = FakeFunctionsClient()
        stubSaves(fns)
        fns.stubError("signKinPhotoUpload", IllegalStateException("Missing or insufficient permissions."))
        val c = controller(fns, this)
        val err = c.updateAndReload("k1", KinPayload(name = "Rex"), KinPhotoChange.Upload(image))

        assertNull(err) // the Kin text saved
        val sign = fns.calls.single { it.first == "signKinPhotoUpload" }.second!!
        assertEquals("k1", (sign["kinId"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertTrue(c.photoNotice!!.contains("Missing or insufficient permissions."))
        assertFalse(c.photoUploading)
    }

    @Test
    fun updateAndReload_aFailedRemoveIsASaveError() = runTest {
        // The text write succeeds; only the photo-clearing call is refused.
        val calls = mutableListOf<kotlinx.serialization.json.JsonObject?>()
        val fns = object : com.kinfolk.portal.firebase.FunctionsClient {
            override suspend fun call(name: String, payload: kotlinx.serialization.json.JsonObject?): kotlinx.serialization.json.JsonObject {
                calls += payload
                val clearsPhoto = payload?.get("kin")?.jsonObject?.containsKey("photoUrl") == true
                if (name == "updateKin" && clearsPhoto) error("Could not reach the server.")
                return buildJsonObject { put("ok", true); put("kin", buildJsonArray { }) }
            }
        }
        val err = KinController("fam1", PortalApi(fns), this)
            .updateAndReload("k1", KinPayload(name = "Rex"), KinPhotoChange.Remove)
        assertEquals("Could not reach the server.", err)
        assertEquals(2, calls.size)
    }
}
