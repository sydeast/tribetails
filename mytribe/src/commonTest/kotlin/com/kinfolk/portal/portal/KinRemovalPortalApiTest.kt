package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1408. What the portal Android app sends to `requestKinRemoval`, and how it
 * reads the removal request off the `deleteKin` read (#1314). Mirrors
 * `mytribe/web/src/api/portal.test.ts` and `mytribe/web/src/lib/kinRemoval.ts`.
 */
class KinRemovalPortalApiTest {

    private val nov2 = 1_793_620_800_000L // 2026-11-02T12:00Z

    private fun requestJson(status: String = "pending") = buildJsonObject {
        put("id", "fam1_k1"); put("kinfolkId", "fam1"); put("kinId", "k1"); put("flatKinId", "flat1")
        put("kinName", "Biscuit"); put("reason", "Rehomed"); put("status", status)
        put("requestedAtMs", nov2); put("resolvedAtMs", JsonNull); put("resolutionNote", JsonNull)
    }

    @Test
    fun `the deleteKin read decodes canDelete and the removal request`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("deleteKin", buildJsonObject {
            put("ok", true); put("deleted", false); put("canDelete", false)
            put("blockedBy", buildJsonArray { add("visits") })
            put("removalRequest", requestJson())
        })
        val options = PortalApi(fake).kinRemovalOptions("fam1", "k1")
        assertFalse(options.canDelete)
        assertEquals("pending", options.request?.status)
        assertEquals("Rehomed", options.request?.reason)
        assertEquals(nov2, options.request?.requestedAtMs)
        assertNull(options.request?.resolutionNote)
        // A read: no confirm on the wire.
        val sent = fake.calls.single().second!!
        assertEquals(setOf("kinfolkId", "kinId"), sent.keys)
    }

    @Test
    fun `a null removal request reads as none`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("deleteKin", buildJsonObject {
            put("ok", true); put("deleted", false); put("canDelete", true)
            put("blockedBy", buildJsonArray {}); put("removalRequest", JsonNull)
        })
        val options = PortalApi(fake).kinRemovalOptions("fam1", "k1")
        assertTrue(options.canDelete)
        assertNull(options.request)
    }

    @Test
    fun `requestKinRemoval sends the trimmed reason and returns the recorded request`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestKinRemoval", buildJsonObject { put("ok", true); put("removalRequest", requestJson()) })
        val recorded = PortalApi(fake).requestKinRemoval("fam1", "k1", "  Rehomed  ")
        assertEquals("fam1_k1", recorded.id)
        val sent = fake.calls.single().second!!
        assertEquals("Rehomed", sent["reason"]!!.jsonPrimitive.content)
        assertEquals("k1", sent["kinId"]!!.jsonPrimitive.content)
        assertEquals("fam1", sent["kinfolkId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a blank reason is not sent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestKinRemoval", buildJsonObject { put("ok", true); put("removalRequest", requestJson()) })
        PortalApi(fake).requestKinRemoval(null, "k1", "   ")
        assertEquals(setOf("kinId"), fake.calls.single().second!!.keys)
    }

    @Test
    fun `the three options match the web`() {
        assertEquals(KinRemovalOption.Delete, kinRemovalOption(KinRemovalOptions(canDelete = true)))
        assertEquals(KinRemovalOption.Request(declined = null), kinRemovalOption(KinRemovalOptions(canDelete = false)))
        val pending = KinRemovalRequest("r", "pending", null, nov2, null, null)
        assertIs<KinRemovalOption.Pending>(kinRemovalOption(KinRemovalOptions(false, pending)))
        val declined = pending.copy(status = "declined", resolutionNote = "Not yet")
        assertEquals(KinRemovalOption.Request(declined = declined), kinRemovalOption(KinRemovalOptions(false, declined)))
        // An archived request never reaches the screen; if it did, it would offer a fresh request.
        assertEquals(KinRemovalOption.Request(declined = null), kinRemovalOption(KinRemovalOptions(false, pending.copy(status = "archived"))))
    }

    // #1912: a Kin that shared its name with an archived Kin was told it had
    // history, and a removal request was sent for it. The server now answers
    // that it has nothing on file while that request is still waiting.
    @Test
    fun `nothing on file with a request still waiting offers delete, as the web does`() {
        val waiting = KinRemovalRequest("fam1_k1", "pending", "Added by mistake", nov2, null, null)
        assertEquals(KinRemovalOption.Delete, kinRemovalOption(KinRemovalOptions(canDelete = true, request = waiting)))
    }

    @Test
    fun `dates read like the web`() {
        assertEquals("Nov 2, 2026", removalDateLabel(nov2, TimeZone.UTC))
        assertNull(removalDateLabel(null))
    }
}
