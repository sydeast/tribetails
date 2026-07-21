package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.VetClinic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for the Vet clinics panel save gating (spec 29 item 8),
 * mirroring the web VetClinicSaveTest: a clinic edit saves only when the name is
 * non-blank AND a real field changed, ignoring id/timestamps and whitespace.
 */
class VetClinicSaveTest {

    private val base = VetClinic(id = "c1", name = "Creekside", phone = "555-1", address = "1 Ln", notes = "n", createdAt = "t0")

    @Test
    fun noChangeIsNotDirty() {
        assertFalse(vetClinicFieldsChanged(base, base.copy(updatedAt = "later")))
    }

    @Test
    fun whitespaceOnlyChangeIsNotDirty() {
        assertFalse(vetClinicFieldsChanged(base, base.copy(name = "  Creekside  ")))
    }

    @Test
    fun fieldChangeIsDirty() {
        assertTrue(vetClinicFieldsChanged(base, base.copy(phone = "555-2")))
    }

    @Test
    fun saveDisabledWhenNameBlank() {
        assertFalse(vetClinicSaveEnabled(base, base.copy(name = "", phone = "555-2")))
    }

    @Test
    fun saveEnabledOnRealChangeWithName() {
        assertTrue(vetClinicSaveEnabled(base, base.copy(address = "2 Ln")))
    }

    @Test
    fun saveDisabledWhenUnchanged() {
        assertFalse(vetClinicSaveEnabled(base, base))
    }

    @Test
    fun websiteChangeIsDirty() {
        assertTrue(vetClinicFieldsChanged(base, base.copy(website = "https://x.com")))
    }

    @Test
    fun emergencyToggleIsDirty() {
        assertTrue(vetClinicFieldsChanged(base, base.copy(isEmergency = true)))
    }
}

/** Search filter + pending/approved partition for the redesigned vet bank panel (parity with web). */
class VetClinicBankTest {

    private val approved = VetClinic(id = "a", name = "Riverside Animal Hospital", phone = "(512) 744-4644", address = "3675 Gattis School Rd", verified = true)
    private val approvedEr = VetClinic(id = "e", name = "Heart of Texas", isEmergency = true, verified = true)
    private val pending = VetClinic(id = "p", name = "New Place", verified = false, submittedBy = "kin1")
    private val legacy = VetClinic(id = "l", name = "Old Clinic")  // verified defaults true

    private val all = listOf(approved, approvedEr, pending, legacy)

    @Test
    fun pendingPicksOnlyUnverified() {
        assertEquals(listOf("p"), pendingVetClinics(all).map { it.id })
    }

    @Test
    fun approvedIncludesLegacyDefaultTrue() {
        assertEquals(setOf("a", "e", "l"), approvedVetClinics(all).map { it.id }.toSet())
    }

    @Test
    fun blankQueryMatchesAll() {
        assertEquals(4, filterVetClinics(all, "").size)
        assertEquals(4, filterVetClinics(all, "   ").size)
    }

    @Test
    fun queryMatchesNameCaseInsensitive() {
        assertEquals(listOf("a"), filterVetClinics(all, "riverside").map { it.id })
    }

    @Test
    fun queryMatchesPhoneAndAddress() {
        assertEquals(listOf("a"), filterVetClinics(all, "744-4644").map { it.id })
        assertEquals(listOf("a"), filterVetClinics(all, "gattis").map { it.id })
    }

    @Test
    fun queryNoMatchIsEmpty() {
        assertTrue(filterVetClinics(all, "zzzznotfound").isEmpty())
    }
}
