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

    /**
     * #829: the desktop update used to be setDoc, a PATCH with no updateMask that
     * replaced the whole document and deleted every field the model does not
     * send. It is now a MERGE whose mask never names an Emergency Contact key, so
     * the array the callable wrote survives a desktop edit. No token in a test, so
     * the write fails after recording what it was asked to do.
     */
    @Test
    fun aKinfolkUpdateIsAMergeWriteThatNeverNamesAnEmergencyContactKey() = runBlocking {
        platformUpdateKinfolk(
            Kinfolk(
                _id = "kf1",
                firstName = "Dana",
                emergencyContacts = buildJsonArray { add(buildJsonObject { put("name", "Rae") }) },
                emergencyContactName = "Rae",
            ),
        )
        val w = JvmFirestoreFixtures.lastWrite
        assertEquals("MERGE", w?.op)
        assertEquals("kinfolk", w?.collection)
        assertEquals("kf1", w?.id)
        val fields = w?.fields.orEmpty()
        assertTrue("firstName" in fields && "serviceAddress" in fields && "tags" in fields, "the mask still names the fields the form edits")
        assertTrue("_id" !in fields)
        for (key in KINFOLK_WRITE_EXCLUDED_KEYS) assertTrue(key !in fields, "$key must not be in the update mask")
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
