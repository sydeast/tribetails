package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareAssignment
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * FirestoreClient.assignAuntie routes through platformInvokeCallable, which the
 * jvm actual answers from JvmFirestoreFixtures.callableResponses and captures
 * as lastCallableName/lastCallablePayloadJson. Pins the payload encoding (ids +
 * uid, JSON null on unassign) and the Ok/Err mapping. The assignment read is
 * pinned against the "familyId/batchId/visitId" fixture map.
 */
class AssignAuntieClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    @Test
    fun assignEncodesIdsAndAuntieUid() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("assignAuntie" to """{"ok":true,"visitId":"v1","auntieUid":"u1"}""")
        val r = FirestoreClient().assignAuntie("fam1", "batch1", "v1", "u1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("assignAuntie", JvmFirestoreFixtures.lastCallableName)
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("fam1", payload["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals("batch1", payload["batchId"]?.jsonPrimitive?.content)
        assertEquals("v1", payload["visitId"]?.jsonPrimitive?.content)
        assertEquals("u1", payload["auntieUid"]?.jsonPrimitive?.content)
    }

    @Test
    fun unassignSendsJsonNullAuntieUid() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("assignAuntie" to """{"ok":true,"visitId":"v1","auntieUid":null}""")
        val r = FirestoreClient().assignAuntie("fam1", "batch1", "v1", null)
        assertTrue(r is WriteResult.Ok)
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        // The key must be present and explicitly null (the backend schema is
        // `auntieUid: string | null`, not optional).
        assertTrue(payload.containsKey("auntieUid"))
        assertEquals(JsonNull, payload["auntieUid"])
    }

    @Test
    fun assignmentReadHonoursFixture() = runBlocking {
        JvmFirestoreFixtures.kinCareAssignments = mapOf(
            "fam1/batch1/v1" to KinCareAssignment(assignedAuntieUid = "u1", auntieDisplayName = "Auntie Dee"),
        )
        val r = FirestoreClient().kinCareAssignment("fam1", "batch1", "v1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("u1", (r as WriteResult.Ok).value?.assignedAuntieUid)
        assertEquals("Auntie Dee", r.value?.auntieDisplayName)
    }

    @Test
    fun unassignedVisitReadsAsNullFields() = runBlocking {
        JvmFirestoreFixtures.kinCareAssignments = mapOf(
            "fam1/batch1/v1" to KinCareAssignment(),
        )
        val r = FirestoreClient().kinCareAssignment("fam1", "batch1", "v1")
        assertTrue(r is WriteResult.Ok)
        assertNull((r as WriteResult.Ok).value?.assignedAuntieUid)
        assertNull(r.value?.auntieDisplayName)
    }

    // ---- listStaff (roster for the Assigned Auntie picker) ----

    @Test
    fun listStaffDecodesRosterInServerOrder() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listStaff" to """{"staff":[
                {"uid":"u1","displayName":"Auntie Dee","email":"dee@tribetails.com"},
                {"uid":"u2","displayName":"Auntie Zee","email":null}
            ]}""",
        )
        val r = FirestoreClient().listStaff()
        assertTrue(r is WriteResult.Ok)
        assertEquals("listStaff", JvmFirestoreFixtures.lastCallableName)
        val staff = (r as WriteResult.Ok).value
        assertEquals(listOf("u1", "u2"), staff.map { it.uid })
        assertEquals("Auntie Dee", staff[0].displayName)
        assertEquals("dee@tribetails.com", staff[0].email)
        assertNull(staff[1].email)
    }

    @Test
    fun listStaffLenientDecodeDropsUidlessRowsAndFallsBackLabel() = runBlocking {
        // Row without a uid can't be assigned, so it is dropped; name/email may
        // be null or absent; pickerLabel falls back name -> email -> uid.
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listStaff" to """{"staff":[
                {"displayName":"Ghost Row"},
                {"uid":"u3","displayName":null,"email":"zed@tribetails.com"},
                {"uid":"u4"}
            ]}""",
        )
        val r = FirestoreClient().listStaff()
        assertTrue(r is WriteResult.Ok)
        val staff = (r as WriteResult.Ok).value
        assertEquals(listOf("u3", "u4"), staff.map { it.uid })
        assertEquals("zed@tribetails.com", staff[0].pickerLabel)
        assertEquals("u4", staff[1].pickerLabel)
    }

    @Test
    fun listStaffEmptyOrMissingArrayDecodesToEmptyList() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listStaff" to """{}""")
        val r = FirestoreClient().listStaff()
        assertTrue(r is WriteResult.Ok)
        assertTrue((r as WriteResult.Ok).value.isEmpty())
    }

    @Test
    fun listStaffMalformedBodySurfacesAsErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listStaff" to "not json {")
        val r = FirestoreClient().listStaff()
        assertTrue(r is WriteResult.Err)
    }
}
