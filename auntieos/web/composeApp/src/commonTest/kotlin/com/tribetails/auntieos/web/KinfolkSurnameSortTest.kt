package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.util.kinfolkSurnameSortKey
import com.tribetails.auntieos.web.util.SortOption
import com.tribetails.auntieos.web.util.sortedByOption
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 03-directory item 3: Kinfolk "A to Z" must order by SURNAME (last name), not first
 * name. The key is surname-primary with a first-name tiebreak; blank last name falls
 * back to the display name (never vanishes to the top).
 */
class KinfolkSurnameSortTest {

    private data class KF(val first: String, val last: String) {
        val display get() = "$first $last".trim()
        val key get() = kinfolkSurnameSortKey(first, last, display)
    }

    @Test
    fun `orders by surname, not first name`() {
        // First names would order Ann < Zed; surnames must order Apple(Zed) < Brown(Ann).
        val zedApple = KF("Zed", "Apple")
        val annBrown = KF("Ann", "Brown")
        val sorted = listOf(annBrown, zedApple).sortedByOption(
            SortOption.AlphaAsc, name = { it.key }, createdAt = { "" }, updatedAt = { "" },
        )
        assertEquals(listOf(zedApple, annBrown), sorted)
    }

    @Test
    fun `first name breaks ties within the same surname`() {
        val key1 = KF("Bob", "Smith").key
        val key2 = KF("Ann", "Smith").key
        // Ann Smith sorts before Bob Smith (tiebreak on first name).
        assertEquals(true, key2 < key1)
    }

    @Test
    fun `blank last name falls back to display name`() {
        assertEquals("madonna", kinfolkSurnameSortKey(firstName = "Madonna", lastName = "", displayName = "Madonna"))
    }

    @Test
    fun `key is case-insensitive`() {
        assertEquals(kinfolkSurnameSortKey("john", "DOE", "john DOE"), kinfolkSurnameSortKey("JOHN", "doe", "JOHN doe"))
    }
}
