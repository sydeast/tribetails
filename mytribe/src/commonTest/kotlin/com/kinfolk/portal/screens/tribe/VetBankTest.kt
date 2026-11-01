package com.kinfolk.portal.screens.tribe

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.VetClinic
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VetBankTest {

    private val catalog = listOf(
        VetClinic(id = "a", name = "Riverside Animal Hospital", phone = "", address = ""),
        VetClinic(id = "b", name = "Oak Hill Veterinary Care", phone = "", address = ""),
    )

    @Test
    fun normalizeCollapsesCaseAndSpace() {
        assertEquals("riverside animal hospital", normalizeClinicName("  Riverside   Animal  Hospital "))
    }

    @Test
    fun clinicAlreadyOnList_matchesIgnoringCaseAndSpace() {
        assertTrue(clinicAlreadyOnList("riverside  animal hospital", catalog))
        assertTrue(clinicAlreadyOnList("OAK HILL VETERINARY CARE", catalog))
    }

    @Test
    fun clinicAlreadyOnList_falseForNovelName() {
        assertFalse(clinicAlreadyOnList("Brand New Pet Clinic", catalog))
    }

    @Test
    fun clinicAlreadyOnList_blankCountsAsOnList_soButtonHides() {
        assertTrue(clinicAlreadyOnList("", catalog))
        assertTrue(clinicAlreadyOnList("   ", catalog))
    }

    @Test
    fun getVetClinics_mapsNewFields() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getVetClinics", buildJsonObject {
            put("clinics", buildJsonArray {
                add(buildJsonObject {
                    put("id", "c1"); put("name", "ER Vet"); put("phone", "(512) 1")
                    put("address", "1 St"); put("website", "https://er.com")
                    put("googleMapsUrl", "https://maps/er"); put("isEmergency", true)
                })
            })
        })
        val clinics = PortalApi(fake).getVetClinics()
        assertEquals(1, clinics.size)
        assertEquals("https://er.com", clinics[0].website)
        assertEquals("https://maps/er", clinics[0].googleMapsUrl)
        assertTrue(clinics[0].isEmergency)
    }

    @Test
    fun submitVetClinic_parsesResult() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("submitVetClinic", buildJsonObject {
            put("clinicId", "new1"); put("created", true); put("pending", true)
        })
        val r = PortalApi(fake).submitVetClinic("New Vet")
        assertEquals("new1", r.clinicId)
        assertTrue(r.created)
        assertTrue(r.pending)
    }

    @Test
    fun submitVetClinic_dedupeResult() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("submitVetClinic", buildJsonObject {
            put("clinicId", "exists"); put("created", false); put("pending", false)
        })
        val r = PortalApi(fake).submitVetClinic("Riverside Animal Hospital")
        assertFalse(r.created)
        assertFalse(r.pending)
    }

    @Test
    fun submitVetClinic_sendsAcknowledgedIds_andParsesTheChoice() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("submitVetClinic", buildJsonObject {
            put("status", "needs_choice"); put("clinicId", ""); put("created", false); put("pending", false)
            put("candidates", buildJsonArray {
                add(buildJsonObject {
                    put("id", "c9"); put("name", "Riverside Vet"); put("address", "9 River Rd"); put("phone", "5125550100")
                    put("isEmergency", true); put("verified", false); put("reason", "similar")
                })
            })
        })
        val r = PortalApi(fake).submitVetClinic("Riverside", acknowledgedMatchIds = listOf("c9", "c4"))
        assertTrue(r.needsChoice)
        assertFalse(r.created)
        assertEquals(1, r.candidates.size)
        val c = r.candidates[0]
        assertEquals("c9", c.id)
        assertEquals("Riverside Vet", c.name)
        assertEquals("9 River Rd", c.address)
        assertTrue(c.isEmergency)
        assertFalse(c.verified)
        val sent = fake.calls.last().second!!
        assertEquals(listOf("c9", "c4"), sent["acknowledgedMatchIds"]!!.jsonArray.map { it.jsonPrimitive.content })
    }
    @Test
    fun submitVetClinic_createdStatus_isNotAChoice() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("submitVetClinic", buildJsonObject {
            put("status", "created"); put("clinicId", "n1"); put("created", true); put("pending", true)
            put("candidates", buildJsonArray {})
        })
        val r = PortalApi(fake).submitVetClinic("Brand New")
        assertFalse(r.needsChoice)
        assertEquals("n1", r.clinicId)
        assertTrue(r.candidates.isEmpty())
        assertEquals(0, fake.calls.last().second!!["acknowledgedMatchIds"]!!.jsonArray.size)
    }
}
