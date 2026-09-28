package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * 2026-09-27 Q3. What portal Android sends for a secondary kinfolk added with no
 * invite (`listSecondaryKinfolk`, `saveSecondaryKinfolk`,
 * `removeSecondaryKinfolk` in `mytribe/functions/src/portal/secondaryKinfolk.ts`)
 * and the `personId` that links a later invite to them.
 */
class SecondaryKinfolkPortalApiTest {

    private fun sam(access: String = "NONE") = buildJsonObject {
        put("personId", "p1"); put("name", "Sam Lee"); put("phone", "+18055550177"); put("email", JsonNull)
        put("access", access); put("memberUid", JsonNull); put("createdAt", JsonNull)
    }

    @Test
    fun `list decodes people with their access state`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listSecondaryKinfolk", buildJsonObject { put("people", buildJsonArray { add(sam("INVITED")) }) })
        val people = PortalApi(fake).listSecondaryKinfolk("fam1")
        val p = people.single()
        assertEquals("p1", p.personId)
        assertEquals("Sam Lee", p.name)
        assertEquals("+18055550177", p.phone)
        assertNull(p.email)
        assertEquals("INVITED", p.access)
        assertEquals("fam1", fake.calls.single().second!!["kinfolkId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `list with no people array is an error, never an empty household`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listSecondaryKinfolk", buildJsonObject { })
        assertFailsWith<IllegalStateException> { PortalApi(fake).listSecondaryKinfolk("fam1") }
    }

    @Test
    fun `save sends name, phone and email, blanks included, and never an invite or permissions`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveSecondaryKinfolk", buildJsonObject { put("person", sam()); put("created", true) })
        val saved = PortalApi(fake).saveSecondaryKinfolk(kinfolkId = "fam1", name = " Sam Lee ", phone = "", email = "")
        val payload = fake.calls.single().second!!
        assertEquals(setOf("kinfolkId", "name", "phone", "email"), payload.keys)
        assertEquals("Sam Lee", payload["name"]!!.jsonPrimitive.content)
        assertEquals("", payload["phone"]!!.jsonPrimitive.content)
        assertEquals("p1", saved.personId)
    }

    @Test
    fun `save with a personId edits that person`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveSecondaryKinfolk", buildJsonObject { put("person", sam()); put("created", false) })
        PortalApi(fake).saveSecondaryKinfolk(kinfolkId = "fam1", personId = "p1", name = "Sam", phone = "805", email = "s@x.com")
        assertEquals("p1", fake.calls.single().second!!["personId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `remove sends the person id`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("removeSecondaryKinfolk", buildJsonObject { put("ok", true) })
        PortalApi(fake).removeSecondaryKinfolk("fam1", "p1")
        val payload = fake.calls.single().second!!
        assertEquals("removeSecondaryKinfolk", fake.calls.single().first)
        assertEquals("p1", payload["personId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an invite carries personId only when one is given`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("addSecondaryContact", buildJsonObject { put("inviteId", "i1") })
        val api = PortalApi(fake)
        api.addSecondaryContact(kinfolkId = "fam1", invitedEmail = "sam@x.com", personId = "p1")
        api.addSecondaryContact(kinfolkId = "fam1", invitedEmail = "jo@x.com")
        assertEquals("p1", fake.calls[0].second!!["personId"]!!.jsonPrimitive.content)
        assertFalse(fake.calls[1].second!!.containsKey("personId"))
    }
}
