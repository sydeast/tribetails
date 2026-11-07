package com.tribetails.auntieos.domain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1605: duplicates get their own names, and CUSTOMIZED waits for a real change. Mirrors the web tests. */
class PackageUndoHelpersTest {
    private fun visit(id: String, time: Int, label: String = "Check-in") = Visit(id, time, "d1", label)
    private fun pkg(overrides: Map<Int, List<Visit>> = emptyMap()) =
        Package("p", "P", listOf(visit("a", 540), visit("b", 720)), overrides, emptyMap(), "21:00", 2.0, "", 0.0)
    @Test
    fun noDayCopyIsNotChanged() {
        assertFalse(dayDiffersFromTemplate(pkg(), 0))
    }
    @Test
    fun aFreshForkIsNotChangedWhateverIdsItMinted() {
        assertFalse(dayDiffersFromTemplate(pkg(mapOf(0 to listOf(visit("x", 720), visit("y", 540)))), 0))
    }
    @Test
    fun aChangedTimeLabelOrCountIs() {
        assertTrue(dayDiffersFromTemplate(pkg(mapOf(0 to listOf(visit("x", 540), visit("y", 780)))), 0))
        assertTrue(dayDiffersFromTemplate(pkg(mapOf(0 to listOf(visit("x", 540, "Walk"), visit("y", 720)))), 0))
        assertTrue(dayDiffersFromTemplate(pkg(mapOf(0 to listOf(visit("x", 540)))), 0))
    }
    @Test
    fun feedsThePricedRow() {
        val forked = pkg(mapOf(0 to listOf(visit("n1", 540), visit("n2", 720))))
        val row = pricePackage(forked, PriceContext(1, 0, DEFAULT_DURATIONS, null)).rows.first()
        assertTrue(row.customized)
        assertFalse(row.changed)
    }
    @Test
    fun copyNamesAreNumbered() {
        assertEquals("Lean copy", uniqueCopyName("Lean", listOf("Lean")))
        assertEquals("Lean copy 2", uniqueCopyName("Lean", listOf("Lean", "Lean copy")))
        assertEquals("Lean copy 3", uniqueCopyName("Lean", listOf("Lean", "Lean copy", "Lean copy 2")))
    }
    @Test
    fun copyingACopyExtendsTheOriginalName() {
        assertEquals("Lean copy 2", uniqueCopyName("Lean copy", listOf("Lean", "Lean copy")))
        assertEquals("Lean copy 3", uniqueCopyName("Lean copy 2", listOf("Lean", "Lean copy", "Lean copy 2")))
    }
}
