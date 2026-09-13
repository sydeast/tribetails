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
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Android portal's half of #818.
 *
 * THE WALL, from the client side. The server refuses `permissions`, `role`,
 * `invitedEmail` and `uid` with `.strict()` schemas that name the offending key
 * — `functions/test/householdContacts.test.ts` pins that in three cases called
 * THE WALL, and it also pins that an ACTIVE SECONDARY is denied on all three
 * callables. What no server test can pin is whether THIS client ever reaches
 * for the invite through the contact door. So the assertions below are on the
 * payload's KEY SET, not only on the values it carries: a spec that checked the
 * four fields it does send would still pass with a fifth smuggled in beside
 * them.
 */
class HouseholdContactsPortalApiTest {

    private fun contactsResponse(vararg rows: kotlinx.serialization.json.JsonObject) = buildJsonObject {
        put("contacts", buildJsonArray { rows.forEach { add(it) } })
    }

    @Test
    fun `save sends exactly the four editable fields, the household and nothing else`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveHouseholdContact", buildJsonObject {
            put("contactId", "c9")
            put("created", true)
        })

        val saved = PortalApi(fake).saveHouseholdContact(
            kinfolkId = "fam1",
            name = "  Ada Rivera ",
            label = " Sister ",
            phone = " 805 555 0143 ",
            email = " ada@example.com ",
        )

        assertEquals("c9", saved.contactId)
        assertTrue(saved.created)
        val payload = fake.calls.single().second!!
        assertEquals(
            setOf("kinfolkId", "name", "label", "phone", "email"),
            payload.keys,
            "a contact payload carries nothing a contact does not have",
        )
        assertNull(payload["permissions"])
        assertNull(payload["role"])
        assertNull(payload["uid"])
        assertNull(payload["invitedEmail"])
        assertEquals("Ada Rivera", payload["name"]!!.jsonPrimitive.content)
        assertEquals("Sister", payload["label"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an edit adds the contact id and never a createdAt`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveHouseholdContact", buildJsonObject {
            put("contactId", "c1")
            put("created", false)
        })

        val saved = PortalApi(fake).saveHouseholdContact(
            kinfolkId = "fam1",
            contactId = "c1",
            name = "Ada Rivera",
            label = "Sister",
            phone = "",
            email = "",
        )

        assertEquals(false, saved.created)
        val payload = fake.calls.single().second!!
        assertEquals(setOf("kinfolkId", "contactId", "name", "label", "phone", "email"), payload.keys)
        // CLEARING STICKS: the emptied fields are SENT as "" so the server can
        // null them. Omitting a blank field leaves the old number on the
        // document forever.
        assertEquals("", payload["phone"]!!.jsonPrimitive.content)
        assertEquals("", payload["email"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a blank contact id is a create, not an edit of nothing`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveHouseholdContact", buildJsonObject { put("contactId", "c9"); put("created", true) })

        PortalApi(fake).saveHouseholdContact(contactId = "   ", name = "Ada", label = "", phone = "", email = "")

        assertEquals(setOf("name", "label", "phone", "email"), fake.calls.single().second!!.keys)
    }

    @Test
    fun `list decodes a row, defaults its label and keeps a half-written one`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "listHouseholdContacts",
            contactsResponse(
                buildJsonObject {
                    put("contactId", "c1")
                    put("name", "Ada Rivera")
                    put("label", "Sister")
                    put("phone", "805 555 0143")
                    put("email", JsonNull)
                    put("createdAt", "2026-09-12T10:00:00.000Z")
                    put("updatedAt", JsonNull)
                },
                // No name and no label: the household has to see it to fix it.
                buildJsonObject { put("contactId", "c2") },
                // No id: nothing could be edited or deleted, so it is dropped
                // rather than drawn with two dead buttons on it.
                buildJsonObject { put("name", "Ghost") },
            ),
        )

        val contacts = PortalApi(fake).listHouseholdContacts("fam1")

        assertEquals(2, contacts.size)
        assertEquals("Sister · 805 555 0143", contacts[0].metaLine())
        assertNull(contacts[0].email)
        assertEquals("(unnamed contact)", contacts[1].name)
        assertEquals(DEFAULT_CONTACT_LABEL, contacts[1].label)
    }

    @Test
    fun `no row carries a permission field, because a contact has nothing to authorise`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "listHouseholdContacts",
            contactsResponse(buildJsonObject { put("contactId", "c1"); put("name", "Ada") }),
        )

        val contact = PortalApi(fake).listHouseholdContacts("fam1").single()

        // The type is the guarantee: HouseholdContact has no permissions, role,
        // uid or invitedEmail to populate. This asserts the decoded shape is
        // that type and not a Member.
        assertEquals(HouseholdContact("c1", "Ada", DEFAULT_CONTACT_LABEL, null, null, null, null), contact)
    }

    @Test
    fun `an unreadable answer throws rather than reading as an empty household`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listHouseholdContacts", buildJsonObject { put("ok", true) })

        // "No contacts" drawn off a payload we could not parse is the
        // fabricated-success failure the repo forbids.
        assertFailsWith<IllegalStateException> { PortalApi(fake).listHouseholdContacts("fam1") }
    }

    @Test
    fun `a denied gate reaches the caller instead of being swallowed`() = runTest {
        val fake = FakeFunctionsClient()
        // What an ACTIVE SECONDARY gets from all three: requireKinfolkPrimary
        // denies them, unchanged from #817.
        fake.stubError("listHouseholdContacts", IllegalStateException("PERMISSION_DENIED: not the primary"))

        val thrown = assertFailsWith<IllegalStateException> { PortalApi(fake).listHouseholdContacts("fam1") }
        assertTrue(com.kinfolk.portal.screens.gallery.isPermissionDenied(thrown.message))
    }

    @Test
    fun `remove sends the contact id and the household, and nothing else`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("removeHouseholdContact", buildJsonObject { put("ok", true) })

        PortalApi(fake).removeHouseholdContact("c1", "fam1")

        val (name, payload) = fake.calls.single()
        assertEquals("removeHouseholdContact", name)
        assertEquals(setOf("kinfolkId", "contactId"), payload!!.keys)
        assertEquals("c1", payload["contactId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `metaLine skips what is absent`() {
        val full = HouseholdContact("c1", "Ada", "Sister", "805 555 0143", "ada@example.com", null, null)
        assertEquals("Sister · 805 555 0143 · ada@example.com", full.metaLine())
        assertEquals("Sister", full.copy(phone = null, email = null).metaLine())
    }
}
