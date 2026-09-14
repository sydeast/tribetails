package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #829. What the portal Android app puts on the wire for Emergency Contacts, and
 * how it reads the answer. The callables are `listEmergencyContacts` and
 * `saveEmergencyContacts` in `mytribe/functions/src/portal/emergencyContacts.ts`.
 */
class EmergencyContactsPortalApiTest {

    private fun rae() = buildJsonObject {
        put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", JsonNull); put("recordedAt", JsonNull); put("updatedAt", JsonNull)
    }

    @Test
    fun `list decodes contacts and canEdit`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(rae()) }); put("canEdit", false); put("legacy", true)
        })
        val r = PortalApi(fake).listEmergencyContacts("fam1")
        assertEquals("Rae Mercer", r.contacts.single().name)
        assertNull(r.contacts.single().relationship)
        assertFalse(r.canEdit)
        assertTrue(r.legacy)
        assertEquals("fam1", fake.calls.single().second!!["kinfolkId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `list with no kinfolkId sends an empty object`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray {}); put("canEdit", true); put("legacy", false)
        })
        PortalApi(fake).listEmergencyContacts()
        assertEquals(emptySet(), fake.calls.single().second!!.keys)
    }

    @Test
    fun `save sends exactly the three fields per slot, in order, relationship cleared as null`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray { add(rae()) }) })
        val saved = PortalApi(fake).saveEmergencyContacts(
            kinfolkId = "fam1",
            contacts = listOf(EmergencyContactInput(" Lee Park ", "8055550177", "  "), EmergencyContactInput("Rae Mercer", "8055550199", "Sister")),
        )
        val payload = fake.calls.single().second!!
        assertEquals(setOf("kinfolkId", "contacts"), payload.keys)
        val slots = payload["contacts"]!!.jsonArray.map { it.jsonObject }
        assertEquals(setOf("name", "phone", "relationship"), slots[0].keys)
        assertEquals("Lee Park", slots[0]["name"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, slots[0]["relationship"])
        assertEquals("Sister", slots[1]["relationship"]!!.jsonPrimitive.content)
        assertEquals("+18055550199", saved.single().phone)
    }

    @Test
    fun `an answer with no contacts array throws instead of reading as none`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", JsonObject(emptyMap()))
        assertFailsWith<IllegalStateException> { PortalApi(fake).listEmergencyContacts() }
        fake.stub("saveEmergencyContacts", JsonObject(emptyMap()))
        assertFailsWith<IllegalStateException> { PortalApi(fake).saveEmergencyContacts(contacts = listOf(EmergencyContactInput("A", "8055550101", ""))) }
    }
}
