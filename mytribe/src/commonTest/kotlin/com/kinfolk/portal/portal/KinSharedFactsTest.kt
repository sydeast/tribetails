package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.screens.kin.sharedFactsPayload
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1310: the five descriptive facts the household shares with the admin. */
class KinSharedFactsTest {

    private fun kin(
        sex: String? = null,
        weight: String? = null,
        colorMarkings: String? = null,
        spayedNeutered: Boolean = false,
        vetInfo: String? = null,
    ) = Kin(
        id = "k1", name = "Buddy", species = "Dog", breed = null, ageYears = null, photoUrl = null,
        status = KinStatus.Active, feedingInstructions = null, walkingInstructions = null,
        medications = null, allergies = null, emergencyNotes = null, sitterNotes = null,
        sex = sex, weight = weight, colorMarkings = colorMarkings, spayedNeutered = spayedNeutered, vetInfo = vetInfo,
    )

    @Test
    fun `getMyKin reads the shared facts and defaults them when absent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1")
                    put("status", "active")
                    put("sex", "Female")
                    put("weight", "52 lbs")
                    put("colorMarkings", "Black")
                    put("spayedNeutered", true)
                    put("vetInfo", "Riverside Animal Hospital")
                })
                add(buildJsonObject {
                    put("id", "k2")
                    put("status", "active")
                })
            })
        })
        val res = PortalApi(fake).getMyKin().kin
        assertEquals("Female", res[0].sex)
        assertEquals("52 lbs", res[0].weight)
        assertEquals("Black", res[0].colorMarkings)
        assertTrue(res[0].spayedNeutered)
        assertEquals("Riverside Animal Hospital", res[0].vetInfo)
        assertNull(res[1].sex)
        assertNull(res[1].vetInfo)
        assertFalse(res[1].spayedNeutered)
    }

    @Test
    fun `updateKin sends the shared facts it was given and omits the rest`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("updateKin", buildJsonObject { put("ok", true) })
        PortalApi(fake).updateKin(
            kinId = "k1",
            kin = KinPayload(name = "Buddy", sex = "Male", weight = "", spayedNeutered = true),
        )
        val sent = fake.calls.single().second!!["kin"]!!.jsonObject
        assertEquals("Male", sent["sex"]!!.jsonPrimitive.content)
        assertEquals("", sent["weight"]!!.jsonPrimitive.content)
        assertEquals(true, sent["spayedNeutered"]!!.jsonPrimitive.booleanOrNull)
        assertFalse(sent.containsKey("colorMarkings"))
        assertFalse(sent.containsKey("vetInfo"))
    }

    @Test
    fun `an unchanged form sends nothing, so a save never rewrites a shared fact`() {
        val k = kin(sex = "F", weight = "52 lbs", colorMarkings = "Black", spayedNeutered = true, vetInfo = "Dr A")
        val facts = sharedFactsPayload(k, sex = "F", weight = "52 lbs", markings = "Black", fixed = true, vet = "Dr A")
        assertNull(facts.sex)
        assertNull(facts.weight)
        assertNull(facts.colorMarkings)
        assertNull(facts.spayedNeutered)
        assertNull(facts.vetInfo)
    }

    @Test
    fun `a changed fact is sent, an emptied one is sent as empty to clear it`() {
        val k = kin(sex = "Male", weight = "52 lbs", vetInfo = "Dr A")
        val facts = sharedFactsPayload(k, sex = "Female", weight = "  ", markings = "", fixed = true, vet = "Dr A")
        assertEquals("Female", facts.sex)
        assertEquals("", facts.weight)
        assertNull(facts.colorMarkings)
        assertEquals(true, facts.spayedNeutered)
        assertNull(facts.vetInfo)
    }

    @Test
    fun `adding a kin sends only what was filled in`() {
        val facts = sharedFactsPayload(null, sex = "", weight = "40 lbs", markings = "", fixed = false, vet = "")
        assertNull(facts.sex)
        assertEquals("40 lbs", facts.weight)
        assertNull(facts.colorMarkings)
        assertNull(facts.spayedNeutered)
        assertNull(facts.vetInfo)
    }
}
