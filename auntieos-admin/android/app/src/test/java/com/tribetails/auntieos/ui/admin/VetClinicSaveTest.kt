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
/**
 * Punchlist B4: the bank's buckets and the usage count that decides whether the
 * operator is shown "retire this" or "3 households read this number".
 */
class VetClinicBucketsTest {
    private val approved = VetClinic(id = "a", name = "Riverside", verified = true)
    private val legacy = VetClinic(id = "l", name = "Old Clinic")          // verified defaults true
    private val pending = VetClinic(id = "p", name = "New Place", verified = false)
    private val retired = VetClinic(id = "r", name = "Closed", archived = true)
    private val rejected = VetClinic(id = "rj", name = "Bad", verified = false, archived = true)
    private val all = listOf(approved, legacy, pending, retired, rejected)
    @Test
    fun `active excludes both pending and retired`() {
        assertEquals(listOf("a", "l"), activeVetClinics(all).map { it.id })
    }
    @Test
    fun `a rejected submission is not pending work any more`() {
        // Rejecting retires the row, so it must not come back as a queue item.
        assertEquals(listOf("p"), pendingVetClinics(all).map { it.id })
    }
    @Test
    fun `retired rows are listed separately, never deleted`() {
        assertEquals(setOf("r", "rj"), archivedVetClinics(all).map { it.id }.toSet())
    }
    @Test
    fun `a legacy row with no archived field reads as active`() {
        assertTrue(activeVetClinics(listOf(legacy)).isNotEmpty())
    }
}
class VetClinicUsageTest {
    private val clinic = VetClinic(id = "c1", name = "Riverside Animal Hospital")
    @Test
    fun `counts a household linked through the regular slot`() {
        val hh = listOf(VetClinicHouseholdRef(vetClinicId = "c1"))
        assertEquals(VetClinicUsage(linked = 1), vetClinicUsage(clinic, hh))
    }
    @Test
    fun `counts a household linked through the emergency slot`() {
        val hh = listOf(VetClinicHouseholdRef(emergencyVetClinicId = "c1"))
        assertEquals(VetClinicUsage(linked = 1), vetClinicUsage(clinic, hh))
    }
    @Test
    fun `counts a household using both slots exactly once`() {
        val hh = listOf(VetClinicHouseholdRef(vetClinicId = "c1", emergencyVetClinicId = "c1"))
        assertEquals(1, vetClinicUsage(clinic, hh).linked)
    }
    /**
     * The distinction the split exists for: a name-only household carries no id,
     * so `updateVetClinic`'s fan-out can never find it. Summing the two would
     * tell the operator a correction reached households it did not.
     */
    @Test
    fun `a legacy name-only household counts as unlinked, not linked`() {
        val hh = listOf(VetClinicHouseholdRef(vetClinicId = "", vetClinicName = "Riverside Animal Hospital"))
        assertEquals(VetClinicUsage(linked = 0, unlinked = 1), vetClinicUsage(clinic, hh))
    }
    @Test
    fun `a name-only match is case and space insensitive`() {
        val hh = listOf(VetClinicHouseholdRef(vetClinicName = "riverside   ANIMAL hospital"))
        assertEquals(1, vetClinicUsage(clinic, hh).unlinked)
    }
    @Test
    fun `a household linked elsewhere is not counted even when the name matches`() {
        val hh = listOf(VetClinicHouseholdRef(vetClinicId = "other", vetClinicName = "Riverside Animal Hospital"))
        assertEquals(VetClinicUsage(0, 0), vetClinicUsage(clinic, hh))
    }
    @Test
    fun `a blank clinic name never name-matches`() {
        val blank = VetClinic(id = "c9", name = "")
        assertEquals(0, vetClinicUsage(blank, listOf(VetClinicHouseholdRef(vetClinicName = ""))).unlinked)
    }
    @Test
    fun `no households means no count`() {
        assertEquals(VetClinicUsage(0, 0), vetClinicUsage(clinic, emptyList()))
    }
}
