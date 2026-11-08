package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.ui.directory.DirectoryDeepLink
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
        val list = filterKinDirectory(roster, "", TAG_FILTER_ALL, inCareOnly = true)
        assertEquals(2, card)
        assertEquals(card, list.size)
        // Off, the tab is every pet it was before.
        assertEquals(4, filterKinDirectory(roster, "", TAG_FILTER_ALL).size)
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
