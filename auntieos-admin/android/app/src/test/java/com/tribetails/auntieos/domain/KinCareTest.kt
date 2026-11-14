package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.ui.directory.DirectoryDeepLink
import com.tribetails.auntieos.ui.directory.KinShow
import com.tribetails.auntieos.ui.directory.kinEmptyStateText
import com.tribetails.auntieos.ui.directory.filterKinDirectory
import com.tribetails.auntieos.ui.directory.TAG_FILTER_ALL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1601: one "in care" rule for Home's card and the Directory's Kin tab. */
class KinCareTest {
    private fun kin(id: String, status: String) = Kin(id = id, name = id, status = status)
    @Test
    fun `inactive and archived are not in care, blank and active are`() {
        assertTrue(isKinInCare("active"))
        assertTrue(isKinInCare(""))
        assertTrue(isKinInCare("prospect"))
        assertFalse(isKinInCare("inactive"))
        assertFalse(isKinInCare(" Inactive "))
        assertFalse(isKinInCare("ARCHIVED"))
    }
    @Test
    fun `the Home count equals the length of the list the card opens`() {
        val roster = listOf(kin("a", "active"), kin("b", "inactive"), kin("c", "archived"), kin("d", ""))
        val card = kinInCareCount(roster)
        val list = filterKinDirectory(roster, "", TAG_FILTER_ALL, show = KinShow.InCare)
        assertEquals(2, card)
        assertEquals(card, list.size)
        // #1902: "All kin" is every Kin that is not archived (it listed the
        // archived one too before, unlike web and desktop); "Archived" lists
        // only the archived one.
        assertEquals(listOf("a", "b", "d"), filterKinDirectory(roster, "", TAG_FILTER_ALL).map { it.id })
        assertEquals(listOf("c"), filterKinDirectory(roster, "", TAG_FILTER_ALL, show = KinShow.Archived).map { it.id })
    }

    @Test
    fun `Archived lists any spelling of archived, and search and tag still narrow it`() {
        val roster = listOf(
            Kin(id = "a", name = "Biscuit", status = "active"),
            Kin(id = "b", name = "Gravy", status = " Archived "),
            Kin(id = "c", name = "Pepper", status = "ARCHIVED"),
        )
        assertEquals(listOf("Gravy", "Pepper"), filterKinDirectory(roster, "", TAG_FILTER_ALL, show = KinShow.Archived).map { it.name })
        assertEquals(listOf("Gravy"), filterKinDirectory(roster, "grav", TAG_FILTER_ALL, show = KinShow.Archived).map { it.name })
        assertEquals(listOf("All kin", "In care", "Archived"), KinShow.entries.map { it.label })
        assertEquals("No archived Kin", kinEmptyStateText("", KinShow.Archived).first)
        assertEquals("No matches for \"grav\"", kinEmptyStateText("grav", KinShow.Archived).first)
    }
    @Test
    fun `the deep link is read once and then forgotten`() {
        DirectoryDeepLink.clear()
        assertFalse(DirectoryDeepLink.consumeKinInCare())
        DirectoryDeepLink.requestKinInCare()
        assertTrue(DirectoryDeepLink.consumeKinInCare())
        assertFalse(DirectoryDeepLink.consumeKinInCare())
    }
}
