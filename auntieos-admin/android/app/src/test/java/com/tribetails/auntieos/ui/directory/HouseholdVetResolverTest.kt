package com.tribetails.auntieos.ui.directory
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.VetClinic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * The Android mirror of `auntieos-admin/src/lib/householdVet.test.ts`. Both
 * platforms resolve the household vet the same way or they will show different
 * vets for the same household, which is the defect this change closes.
 *
 * Replaces DirectoryViewModelVetPickerTest and DirectoryViewModelVetTest, which
 * pinned the kinfolk-doc vet picker and its read-only inheritance. That picker
 * is gone: the vet is authored on Household Data now (operator ruling
 * 2026-08-01), so those tests covered a write path that must no longer exist.
 */
class HouseholdVetResolverTest {
    private val riverside = VetClinic(
        id = "c1",
        name = "Riverside Animal Hospital",
        phone = "(512) 555 0100",
        address = "418 Mill St",
        hours = "Mon to Fri 8a to 6p",
    )
    private val er = VetClinic(
        id = "er1",
        name = "Austin Pet ER",
        phone = "(512) 555 0300",
        hours = "24 hours",
        isEmergency = true,
    )
    private val catalog = listOf(riverside, er)
    @Test
    fun `a linked household resolves through the clinic`() {
        val vet = resolveHouseholdVet(HouseholdData(primaryVetClinicId = "c1"), catalog)
        assertEquals("Riverside Animal Hospital", vet.primary.name)
        assertEquals("(512) 555 0100", vet.primary.phone)
        assertTrue(vet.primary.linked)
    }
    /** Hours belong to the practice, so a linked household never reads its own copy. */
    @Test
    fun `hours come from the clinic, not the household`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "c1", primaryVetHours = "STALE, do not use"),
            catalog,
        )
        assertEquals("Mon to Fri 8a to 6p", vet.primary.hours)
    }
    /** The whole point: one copy. Stale text must not shadow the catalog. */
    @Test
    fun `legacy free text is ignored entirely when linked`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "c1", primaryVetName = "Some Old Clinic", primaryVetPhone = "999"),
            catalog,
        )
        assertEquals("Riverside Animal Hospital", vet.primary.name)
        assertEquals("(512) 555 0100", vet.primary.phone)
    }
    @Test
    fun `a correction to the clinic is seen with no household write`() {
        val corrected = listOf(riverside.copy(phone = "(512) 555 0199"))
        val vet = resolveHouseholdVet(HouseholdData(primaryVetClinicId = "c1"), corrected)
        assertEquals("(512) 555 0199", vet.primary.phone)
    }
    @Test
    fun `the emergency vet stays a distinct practice`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "c1", emergencyVetClinicId = "er1"),
            catalog,
        )
        assertEquals("Riverside Animal Hospital", vet.primary.name)
        assertEquals("Austin Pet ER", vet.emergency.name)
        assertEquals("24 hours", vet.emergency.hours)
    }
    @Test
    fun `a primary vet never leaks into the emergency slot`() {
        val vet = resolveHouseholdVet(HouseholdData(primaryVetClinicId = "c1"), catalog)
        assertFalse(vet.emergency.hasAny)
    }
    @Test
    fun `an unlinked household still shows what is on file`() {
        val vet = resolveHouseholdVet(
            HouseholdData(
                primaryVetName = "Barton Creek Animal Hospital",
                primaryVetPhone = "(512) 555 0134",
                primaryVetHours = "Mon to Fri 9a to 5p",
            ),
            catalog,
        )
        assertEquals("Barton Creek Animal Hospital", vet.primary.name)
        assertEquals("Mon to Fri 9a to 5p", vet.primary.hours)
        assertFalse(vet.primary.linked)
    }
    /**
     * Falling back here would hide a broken link behind stale data, which is
     * exactly how a wrong number survives a migration.
     */
    @Test
    fun `a dangling clinic id fails loud instead of using stale text`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "gone", primaryVetName = "Stale Clinic", primaryVetPhone = "999"),
            catalog,
        )
        assertTrue(vet.primary.dangling)
        assertEquals("", vet.primary.name)
        assertEquals("", vet.primary.phone)
    }
    @Test
    fun `an unresolved id while the catalog is empty reads as dangling`() {
        val vet = resolveHouseholdVet(HouseholdData(primaryVetClinicId = "c1"), emptyList())
        assertTrue(vet.primary.dangling)
    }
    @Test
    fun `a retired clinic is flagged but still shown`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "c1"),
            listOf(riverside.copy(archived = true)),
        )
        assertTrue(vet.primary.archived)
        assertEquals("Riverside Animal Hospital", vet.primary.name)
    }
    @Test
    fun `a null household resolves to blanks`() {
        val vet = resolveHouseholdVet(null, catalog)
        assertFalse(vet.primary.hasAny)
        assertFalse(vet.emergency.hasAny)
    }
    @Test
    fun `a whitespace-only clinic id counts as unlinked`() {
        val vet = resolveHouseholdVet(
            HouseholdData(primaryVetClinicId = "   ", primaryVetName = "On File"),
            catalog,
        )
        assertFalse(vet.primary.linked)
        assertEquals("On File", vet.primary.name)
    }
}
