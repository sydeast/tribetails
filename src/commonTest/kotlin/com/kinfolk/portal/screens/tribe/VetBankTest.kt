package com.kinfolk.portal.screens.tribe

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.VetClinic
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
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
}
