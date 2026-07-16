package com.kinfolk.portal.screens.kintales

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class KinTalesLayoutTest {

    @Test
    fun columnCount_matchesBreakpoint() {
        assertEquals(2, talesColumnCount(isWide = true))
        assertEquals(1, talesColumnCount(isWide = false))
    }

    @Test
    fun singleColumn_returnsItemsUnchanged() {
        val items = listOf("a", "b", "c")
        assertEquals(listOf(items), splitIntoColumns(items, 1))
    }

    @Test
    fun twoColumns_roundRobinPreservesFeedOrder() {
        val items = listOf(1, 2, 3, 4, 5)
        assertEquals(
            listOf(listOf(1, 3, 5), listOf(2, 4)),
            splitIntoColumns(items, 2),
        )
    }

    @Test
    fun emptyList_yieldsEmptyColumns() {
        assertEquals(
            listOf(emptyList<Int>(), emptyList()),
            splitIntoColumns(emptyList<Int>(), 2),
        )
    }

    @Test
    fun fewerItemsThanColumns_leavesTrailingColumnsEmpty() {
        assertEquals(
            listOf(listOf("only"), emptyList()),
            splitIntoColumns(listOf("only"), 2),
        )
    }

    @Test
    fun zeroColumns_throws() {
        assertFailsWith<IllegalArgumentException> { splitIntoColumns(listOf(1), 0) }
    }
}
