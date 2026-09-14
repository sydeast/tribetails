package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EmergencyContactsClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
        JvmFirestoreFixtures.lastWrite = null
        JvmFirestoreFixtures.lastCallableName = null
        JvmFirestoreFixtures.lastCallablePayloadJson = null
    }

    @Test
    fun listDecodesContactsAndCanEdit() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listEmergencyContacts" to """{"contacts":[{"name":"Rae","phone":"+18055550199","relationship":null,"recordedAt":null,"updatedAt":null}],"canEdit":true,"legacy":false}""",
        )
        val r = FirestoreClient().listEmergencyContacts("kf1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("Rae", r.value.contacts.single().name)
        assertTrue(r.value.canEdit)
        assertEquals("""{"kinfolkId":"kf1"}""", JvmFirestoreFixtures.lastCallablePayloadJson)
    }

    @Test
    fun saveSendsSlotsInOrderWithRelationshipClearedAsNull() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("saveEmergencyContacts" to """{"contacts":[]}""")
        val r = FirestoreClient().saveEmergencyContacts("kf1", listOf(EmergencyContactDraft(" Rae ", "8055550199", ""), EmergencyContactDraft("Lee", "8055550177", "Neighbour")))
        assertTrue(r is WriteResult.Ok)
        assertEquals("saveEmergencyContacts", JvmFirestoreFixtures.lastCallableName)
        assertEquals(
            Json.parseToJsonElement("""{"kinfolkId":"kf1","contacts":[{"name":"Rae","phone":"8055550199","relationship":null},{"name":"Lee","phone":"8055550177","relationship":"Neighbour"}]}"""),
            Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!),
        )
    }

    @Test
    fun anUnreadableAnswerIsAnError() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listEmergencyContacts" to """{}""", "saveEmergencyContacts" to """{"ok":true}""")
        assertTrue(FirestoreClient().listEmergencyContacts("kf1") is WriteResult.Err)
        assertTrue(FirestoreClient().saveEmergencyContacts("kf1", listOf(EmergencyContactDraft("Rae", "805"))) is WriteResult.Err)
    }

    private val onFile = Kinfolk(
        _id = "kf1",
        firstName = "Dana",
        lastName = "Mercer",
        status = "prospect",
        outstandingBalance = "42.50",
        tags = listOf("VIP"),
        gateCode = "1234",
        emergencyContacts = buildJsonArray { add(buildJsonObject { put("name", "Rae") }) },
        emergencyContactName = "Rae",
    )

    /**
     * #829 review: the desktop update used to send the whole model, so it
     * overwrote concurrent changes to fields the form never touched. An edit that
     * changes one field is now a MERGE naming only that field; unchanged
     * outstandingBalance, status and tags are never in the mask. No token in a
     * test, so the write fails after recording what it was asked to do.
     */
    @Test
    fun anEditChangingOneFieldNamesOnlyThatField() = runBlocking {
        val r = FirestoreClient().updateKinfolk(onFile, onFile.copy(gateCode = "9999"))
        assertTrue(r is WriteResult.Err)
        val w = JvmFirestoreFixtures.lastWrite
        assertEquals("MERGE", w?.op)
        assertEquals("kinfolk", w?.collection)
        assertEquals("kf1", w?.id)
        assertEquals(setOf("gateCode"), w?.fields)
    }

    @Test
    fun aTagSaveNamesOnlyTags() = runBlocking {
        FirestoreClient().updateKinfolkTags(onFile, listOf("VIP", "Cats"))
        assertEquals(setOf("tags"), JvmFirestoreFixtures.lastWrite?.fields)
    }

    @Test
    fun anUnchangedSaveWritesNothing() = runBlocking {
        val r = FirestoreClient().updateKinfolk(onFile, onFile.copy())
        assertTrue(r is WriteResult.Ok)
        assertEquals(null, JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun theDiffNeverCarriesAnEmergencyContactKeyOrTheId() {
        val edited = onFile.copy(
            firstName = "Dani",
            emergencyContacts = null,
            emergencyContactName = "",
            emergencyContactPhone = "805",
        )
        assertEquals(setOf("firstName"), kinfolkChangedFields(onFile, edited).keys)
        assertEquals(emptySet(), kinfolkChangedFields(onFile, onFile.copy(_id = "other")).keys)
    }

    @Test
    fun aKinfolkCreateBodyCarriesNoEmergencyContactKey() = runBlocking {
        platformCreateKinfolk(Kinfolk(firstName = "Dana"))
        val w = JvmFirestoreFixtures.lastWrite
        assertEquals("POST", w?.op)
        assertEquals("kinfolk", w?.collection)
        val fields = w?.fields.orEmpty()
        assertTrue("firstName" in fields)
        for (key in KINFOLK_WRITE_EXCLUDED_KEYS) assertTrue(key !in fields, "$key must not be in the create body")
    }
}
