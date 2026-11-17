package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `getHouseholdKinRoster` (#1822, #1862): the Kin a booking covers and whether
 * they can be chosen, as the server answers it.
 */
class KinRosterPortalApiTest {

    private fun answer(chooseKin: Any? = false) = buildJsonObject {
        put("kin", buildJsonArray {
            add(buildJsonObject { put("id", "k1"); put("name", "Buddy") })
            add(buildJsonObject { put("id", "k2"); put("name", JsonNull) })
        })
        when (chooseKin) {
            is Boolean -> put("chooseKin", chooseKin)
            is String -> put("chooseKin", chooseKin)
            else -> Unit
        }
    }

    @Test
    fun `asks for the household by its id`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", answer())
        PortalApi(fake).getHouseholdKinRoster("fam1")
        val (name, payload) = fake.calls.single()
        assertEquals("getHouseholdKinRoster", name)
        assertEquals("fam1", payload?.get("kinfolkId")?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `sends no household when none is named, and the server picks the caller's own`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", answer())
        PortalApi(fake).getHouseholdKinRoster()
        assertNull(fake.calls.single().second)
    }

    @Test
    fun `decodes the Kin in the server's order, a missing name as null`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", answer())
        val roster = PortalApi(fake).getHouseholdKinRoster("fam1")
        assertEquals(listOf(RosterKin("k1", "Buddy"), RosterKin("k2", null)), roster.kin)
    }

    @Test
    fun `reads the Kin's own card id when the server sends one, else the id`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject { put("id", "flat-1"); put("name", "Buddy"); put("householdId", "card-1") })
                add(buildJsonObject { put("id", "k2"); put("name", "Willow") })
            })
        })
        val kin = PortalApi(fake).getHouseholdKinRoster("fam1").kin
        assertEquals(listOf("card-1", "k2"), kin.map { it.householdId })
        assertEquals(listOf("flat-1", "k2"), kin.map { it.id })
    }

    @Test
    fun `choosing Kin is on only when the server says exactly true`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", answer(chooseKin = true))
        assertTrue(PortalApi(fake).getHouseholdKinRoster("fam1").chooseKin)

        fake.stub("getHouseholdKinRoster", answer(chooseKin = false))
        assertFalse(PortalApi(fake).getHouseholdKinRoster("fam1").chooseKin)

        fake.stub("getHouseholdKinRoster", answer(chooseKin = null))
        assertFalse(PortalApi(fake).getHouseholdKinRoster("fam1").chooseKin)

        fake.stub("getHouseholdKinRoster", answer(chooseKin = "yes"))
        assertFalse(PortalApi(fake).getHouseholdKinRoster("fam1").chooseKin)
    }

    @Test
    fun `drops a row with no id rather than booking for a blank`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject { put("name", "No Id") })
                add(buildJsonObject { put("id", ""); put("name", "Blank Id") })
                add(buildJsonObject { put("id", "k1"); put("name", "Buddy") })
            })
            put("chooseKin", true)
        })
        assertEquals(listOf(RosterKin("k1", "Buddy")), PortalApi(fake).getHouseholdKinRoster("fam1").kin)
    }

    @Test
    fun `an older server with no Kin list is an error, never an empty home`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getHouseholdKinRoster", buildJsonObject { })
        assertFailsWith<IllegalStateException> { PortalApi(fake).getHouseholdKinRoster("fam1") }
    }

    @Test
    fun `a refused call reaches the caller`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getHouseholdKinRoster", IllegalStateException("permission-denied"))
        assertFailsWith<IllegalStateException> { PortalApi(fake).getHouseholdKinRoster("fam1") }
    }
}
