package com.tribetails.auntieos.web.data
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** 2026-09-27 Q3: the desktop console's three secondary kinfolk callables. */
class SecondaryKinfolkClientTest {
    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.lastCallableName = null
        JvmFirestoreFixtures.lastCallablePayloadJson = null
    }
    @Test
    fun listDecodesEveryAccessStateAndDropsARowWithNoId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listSecondaryKinfolk" to """{"people":[
              {"personId":"p1","name":"Sam Lee","phone":"+18055550177","email":null,"access":"NONE","memberUid":null},
              {"personId":"p2","name":"Jo","phone":null,"email":"jo@example.com","access":"INVITED"},
              {"personId":"p3","name":"Ann","access":"ACTIVE","memberUid":"u9"},
              {"name":"no id"}]}""",
        )
        val r = FirestoreClient().listSecondaryKinfolk("kf1")
        assertTrue(r is WriteResult.Ok)
        assertEquals(listOf("p1", "p2", "p3"), r.value.map { it.personId })
        assertEquals(listOf(PersonAccess.NONE, PersonAccess.INVITED, PersonAccess.ACTIVE), r.value.map { it.access })
        assertNull(r.value[0].email)
        assertEquals("""{"kinfolkId":"kf1"}""", JvmFirestoreFixtures.lastCallablePayloadJson)
    }
    @Test
    fun aMissingPeopleArrayIsAnErrorNotAnEmptyHousehold() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listSecondaryKinfolk" to """{}""")
        assertTrue(FirestoreClient().listSecondaryKinfolk("kf1") is WriteResult.Err)
    }
    @Test
    fun saveSendsExactlyTheThreeFieldsBlanksIncludedAndNoInviteOrAccessKey() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("saveSecondaryKinfolk" to """{"person":{"personId":"p9","name":"Sam Lee","access":"NONE"},"created":true}""")
        val r = FirestoreClient().saveSecondaryKinfolk("kf1", SecondaryPersonDraft(name = " Sam Lee ", phone = "", email = " sam@example.com "))
        assertTrue(r is WriteResult.Ok)
        assertEquals("p9", r.value.personId)
        assertEquals("saveSecondaryKinfolk", JvmFirestoreFixtures.lastCallableName)
        assertEquals(
            Json.parseToJsonElement("""{"kinfolkId":"kf1","name":"Sam Lee","phone":"","email":"sam@example.com"}"""),
            Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!),
        )
    }
    @Test
    fun anEditIsSeededFromTheStoredPersonAndCarriesItsId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("saveSecondaryKinfolk" to """{"person":{"personId":"p1","name":"Sam Leigh"}}""")
        val stored = SecondaryPerson("p1", "Sam Lee", "+18055550177", "sam@example.com", PersonAccess.INVITED, null)
        FirestoreClient().saveSecondaryKinfolk("kf1", stored.toDraft().copy(name = "Sam Leigh"))
        assertEquals(
            Json.parseToJsonElement("""{"kinfolkId":"kf1","personId":"p1","name":"Sam Leigh","phone":"+18055550177","email":"sam@example.com"}"""),
            Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!),
        )
    }
    @Test
    fun aBlankNameIsRefusedWithTheServerWordingAndNoCall() = runBlocking {
        val r = FirestoreClient().saveSecondaryKinfolk("kf1", SecondaryPersonDraft(name = "  "))
        assertTrue(r is WriteResult.Err)
        assertEquals("A secondary kinfolk needs a name.", r.message)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }
    @Test
    fun removeSendsTheHouseholdAndThePerson() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("removeSecondaryKinfolk" to """{"ok":true}""")
        assertTrue(FirestoreClient().removeSecondaryKinfolk("kf1", "p1") is WriteResult.Ok)
        assertEquals("""{"kinfolkId":"kf1","personId":"p1"}""", JvmFirestoreFixtures.lastCallablePayloadJson)
    }
}
