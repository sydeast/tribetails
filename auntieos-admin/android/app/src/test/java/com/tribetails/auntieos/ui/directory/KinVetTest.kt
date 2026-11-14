package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.VetClinic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1908 kin-vet (owner ruling 2026-11-12): a Kin goes to the household's vet
 * unless "Different vet for this Kin" names one of its own.
 */
class KinVetTest {

    private val cedar = VetClinic(id = "c1", name = "Cedar Animal Care", phone = "555 0142", address = "1 Main St")
    private val river = VetClinic(id = "c2", name = "Riverside Vets", phone = "555 0199", address = "2 River Rd")
    private val catalog = listOf(cedar, river)
    private val household = resolveHouseholdVet(HouseholdData(primaryVetClinicId = "c1"), catalog)

    @Test
    fun `a Kin with no vet of its own goes to the household vet`() {
        val v = resolveKinVet("", household, catalog)
        assertTrue(v.fromHousehold)
        assertEquals("Cedar Animal Care", v.vet.name)
    }

    @Test
    fun `a null override reads as none (an older doc)`() {
        assertTrue(resolveKinVet(null, household, catalog).fromHousehold)
    }

    @Test
    fun `a Kin with its own vet goes to that one, not the household vet`() {
        val v = resolveKinVet("c2", household, catalog)
        assertFalse(v.fromHousehold)
        assertEquals("Riverside Vets", v.vet.name)
        assertEquals("Riverside Vets · 555 0199 · 2 River Rd", vetLine(v.vet))
    }

    @Test
    fun `an own vet no longer in the catalog is reported, never swapped for the household vet`() {
        val v = resolveKinVet("gone", household, catalog)
        assertFalse(v.fromHousehold)
        assertTrue(v.vet.dangling)
        assertFalse(v.vet.hasAny)
    }

    @Test
    fun `unticking the box clears the Kin vet, whatever was picked`() {
        assertEquals("", ownVetClinicIdToSave(differentVet = false, picked = "c2"))
        assertEquals("c2", ownVetClinicIdToSave(differentVet = true, picked = " c2 "))
        assertEquals("", ownVetClinicIdToSave(differentVet = true, picked = ""))
    }

    @Test
    fun `the dropdown offers every clinic a household may pick, by name`() {
        val clinics = listOf(
            river,
            cedar,
            VetClinic(id = "c3", name = "Old Clinic", archived = true),
            VetClinic(id = "c4", name = "Waiting Clinic", verified = false),
            VetClinic(id = "c5", name = ""),
        )
        assertEquals(listOf("c1", "c2"), pickableVetClinics(clinics).map { it.id })
    }

    @Test
    fun `the old free-text vet note shows only when no clinic resolves`() {
        assertFalse(showLegacyVetNote(resolveKinVet("", household, catalog), "Dr A"))
        val none = resolveKinVet("", resolveHouseholdVet(null, catalog), catalog)
        assertTrue(showLegacyVetNote(none, "Dr A"))
        assertFalse(showLegacyVetNote(none, ""))
        assertFalse(showLegacyVetNote(none, null))
    }

    @Test
    fun `the dropdown names its rows`() {
        assertEquals("Choose a vet", kinVetOptionLabel("", catalog))
        assertEquals("Riverside Vets", kinVetOptionLabel("c2", catalog))
        assertEquals("A vet no longer on the list", kinVetOptionLabel("gone", catalog))
    }
}
