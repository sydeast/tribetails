package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 03-directory item 3: surname sort key (parity with web KinfolkSurnameSortTest). */
class KinfolkSortTest {

    @Test
    fun `orders by surname not first name`() {
        val zedApple = kinfolkSurnameSortKey("Zed", "Apple", "Zed Apple")
        val annBrown = kinfolkSurnameSortKey("Ann", "Brown", "Ann Brown")
        assertTrue(zedApple < annBrown)
    }

    @Test
    fun `first name breaks ties within a surname`() {
        assertTrue(kinfolkSurnameSortKey("Ann", "Smith", "Ann Smith") < kinfolkSurnameSortKey("Bob", "Smith", "Bob Smith"))
    }

    @Test
    fun `blank last name falls back to display name`() {
        assertEquals("madonna", kinfolkSurnameSortKey("Madonna", "", "Madonna"))
    }

    @Test
    fun `key is case-insensitive`() {
        assertEquals(kinfolkSurnameSortKey("john", "DOE", "john DOE"), kinfolkSurnameSortKey("JOHN", "doe", "JOHN doe"))
    }
}
