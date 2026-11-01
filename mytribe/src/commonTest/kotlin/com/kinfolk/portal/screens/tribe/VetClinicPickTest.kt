package com.kinfolk.portal.screens.tribe
import com.kinfolk.portal.portal.VetClinic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
class VetClinicPickTest {
    private fun clinic(id: String, name: String, phone: String = "", address: String = "") =
        VetClinic(id = id, name = name, phone = phone, address = address)
    private val catalog = listOf(
        clinic("a", "Ridgeline Animal Hospital", "8055550170", "12 Ridge Rd"),
        clinic("b", "Harbor Vet"),
        clinic("c", "Ridge Cats Only"),
    )
    @Test
    fun matches_areCaseInsensitiveSubstrings_inCatalogOrder() {
        assertEquals(listOf("a", "c"), vetClinicMatches("RIDGE", catalog).map { it.id })
    }
    @Test
    fun matches_blankQueryMatchesNothing_andResultsAreCapped() {
        assertEquals(emptyList(), vetClinicMatches("  ", catalog))
        val many = (1..20).map { clinic("c$it", "Vet $it") }
        assertEquals(8, vetClinicMatches("vet", many).size)
    }
    @Test
    fun onFile_prefersTheCatalogRow() {
        assertEquals("Harbor Vet", clinicOnFile("b", catalog, clinic("b", "Stale Name"))?.name)
    }
    @Test
    fun onFile_fallsBackToThePickedClinic_whenTheCatalogDoesNotListIt() {
        val added = clinic("new-1", "Just Added")
        assertEquals(added, clinicOnFile("new-1", catalog, added))
    }
    @Test
    fun onFile_isNullForNoLinkOrAnUnresolvableId_andIgnoresAPickedClinicForADifferentId() {
        assertNull(clinicOnFile("", catalog, null))
        assertNull(clinicOnFile("   ", catalog, clinic("x", "X")))
        assertNull(clinicOnFile("gone", catalog, null))
        assertNull(clinicOnFile("gone", catalog, clinic("other", "Other")))
    }
    @Test
    fun detailLine_formatsThePhone_andDropsBlanks() {
        assertEquals("(805) 555-0170 · 12 Ridge Rd", clinicDetailLine("+18055550170", " 12 Ridge Rd "))
        assertEquals("12 Ridge Rd", clinicDetailLine("", "12 Ridge Rd"))
        assertEquals("(805) 555-0170", clinicDetailLine("805-555-0170", ""))
        assertEquals("", clinicDetailLine("", ""))
    }
    @Test
    fun title_marksEmergencyClinics() {
        assertEquals("ER Vet · 24hr", clinicTitle("ER Vet", true))
        assertEquals("ER Vet", clinicTitle("ER Vet", false))
    }
}
