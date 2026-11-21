package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which Kin a visit covers, admin Android half (#1822, #1862, #2032). Operator
 * ruling 2026-11-12: every visit covers every Kin, and choosing specific Kin
 * is a feature flag that is off by default.
 *
 * The web mirror is auntieos-admin/src/lib/kinChoice.test.ts.
 */
class KinChoiceTest {

    private val buddy = RosterKin("k1", "Buddy")
    private val willow = RosterKin("k2", "Willow")
    private val maple = RosterKin("k3", null)
    private val home = listOf(buddy, willow, maple)

    // ── the server's answer ─────────────────────────────────────────────────

    @Test
    fun `decodes the Kin in the server's order and whether they can be chosen`() {
        val roster = householdKinRosterOf(
            mapOf(
                "kin" to listOf(
                    mapOf("id" to "k2", "name" to "Willow"),
                    mapOf("id" to "k1", "name" to "Buddy", "adminId" to "flat1"),
                ),
                "chooseKin" to true,
            ),
        )
        assertEquals(HouseholdKinRoster(listOf(willow, buddy), chooseKin = true), roster)
    }

    @Test
    fun `choosing is on only when the server says exactly true`() {
        for (answer in listOf<Any?>(false, null, "true", 1)) {
            val roster = householdKinRosterOf(mapOf("kin" to emptyList<Any>(), "chooseKin" to answer))
            assertEquals("chooseKin=$answer", false, roster?.chooseKin)
        }
        assertEquals(false, householdKinRosterOf(mapOf("kin" to emptyList<Any>()))?.chooseKin)
    }

    @Test
    fun `a Kin with no name is kept, a row with no id is dropped`() {
        val roster = householdKinRosterOf(
            mapOf(
                "kin" to listOf(
                    mapOf("id" to "k3", "name" to null),
                    mapOf("id" to "k4", "name" to "  "),
                    mapOf("name" to "No Id"),
                    mapOf("id" to ""),
                    7,
                    null,
                ),
            ),
        )
        assertEquals(listOf(RosterKin("k3", null), RosterKin("k4", null)), roster?.kin)
    }

    @Test
    fun `an answer with no Kin list is no answer, never an empty home`() {
        assertNull(householdKinRosterOf(null))
        assertNull(householdKinRosterOf(emptyMap()))
        assertNull(householdKinRosterOf(mapOf("kin" to "none")))
    }

    @Test
    fun `a Kin with no name on file is never drawn as a blank`() {
        assertEquals("Unnamed Kin", maple.label)
        assertEquals("Unnamed Kin", RosterKin("k9", "  ").label)
        assertEquals("Buddy", buddy.label)
    }

    // ── choosing off, the default ───────────────────────────────────────────

    @Test
    fun `with choosing off every Kin is covered and nothing is named`() {
        assertTrue(KinChoice().coversAll(chooseKin = false))
        assertEquals(emptyList<String>(), KinChoice().kinIdsToSend(home, chooseKin = false))
        assertEquals(home, KinChoice().covered(home, chooseKin = false))
    }

    @Test
    fun `with choosing off a narrowing held from before does not count`() {
        val stale = KinChoice(allKin = false, selectedIds = setOf("k2"))
        assertTrue(stale.coversAll(chooseKin = false))
        assertTrue(stale.isSelected("k1", chooseKin = false))
        assertEquals(emptyList<String>(), stale.kinIdsToSend(home, chooseKin = false))
        assertFalse(KinChoice(allKin = false).noneChosen(home, chooseKin = false))
    }

    @Test
    fun `a draft saved with choosing off carries no chosen-with-choosing-on stamp`() {
        assertFalse(KinChoice().chosenWithFlagOn(chooseKin = false))
        assertFalse(KinChoice(allKin = false, selectedIds = setOf("k2")).chosenWithFlagOn(chooseKin = false))
    }

    @Test
    fun `a draft saved with choosing on is stamped, whether narrowed or for every Kin`() {
        assertTrue(KinChoice(allKin = false, selectedIds = setOf("k2")).chosenWithFlagOn(chooseKin = true))
        assertTrue(KinChoice().chosenWithFlagOn(chooseKin = true))
    }

    // ── choosing on ─────────────────────────────────────────────────────────

    @Test
    fun `with choosing on every Kin starts chosen, and left alone nothing is named`() {
        val start = KinChoice()
        assertTrue(home.all { start.isSelected(it.id, chooseKin = true) })
        assertEquals(emptyList<String>(), start.kinIdsToSend(home, chooseKin = true))
    }

    @Test
    fun `unticking a Kin sends only the Kin left chosen, in roster order`() {
        val choice = KinChoice().toggle("k2", home)
        assertFalse(choice.isSelected("k2", chooseKin = true))
        assertEquals(listOf("k1", "k3"), choice.kinIdsToSend(home, chooseKin = true))
    }

    @Test
    fun `a narrowed choice stores the names of the Kin left chosen, and every Kin stores none`() {
        val choice = KinChoice().toggle("k2", home)
        val expected = home.filter { it.id != "k2" }.mapNotNull { it.name }
        assertEquals(expected, choice.kinNamesToStore(home, chooseKin = true))
        assertEquals(emptyList<String>(), KinChoice().kinNamesToStore(home, chooseKin = true))
        // Choosing off: a narrowing held from before names nobody, as it sends no ids.
        assertEquals(emptyList<String>(), choice.kinNamesToStore(home, chooseKin = false))
        // A Kin with no name on file adds no blank name.
        val nameless = listOf(RosterKin("k1", null), RosterKin("k2", "Maple"), RosterKin("k3", " "))
        assertEquals(emptyList<String>(), KinChoice().toggle("k2", nameless).kinNamesToStore(nameless, chooseKin = true))
    }
    @Test
    fun `choosing the last unticked Kin is every Kin again`() {
        assertEquals(KinChoice(), KinChoice().toggle("k2", home).toggle("k2", home))
    }

    @Test
    fun `with no Kin chosen the form must not submit`() {
        val none = KinChoice().toggle("k1", home).toggle("k2", home).toggle("k3", home)
        assertTrue(none.noneChosen(home, chooseKin = true))
        assertFalse(KinChoice().noneChosen(home, chooseKin = true))
    }

    @Test
    fun `a household with no Kin on file never blocks the form`() {
        assertFalse(KinChoice(allKin = false).noneChosen(emptyList(), chooseKin = true))
        assertEquals(emptyList<String>(), KinChoice(allKin = false).kinIdsToSend(emptyList(), chooseKin = true))
    }

    @Test
    fun `a chosen id that is no longer on the roster is dropped`() {
        val choice = KinChoice(allKin = false, selectedIds = setOf("gone", "k1"))
        assertEquals(listOf("k1"), choice.kinIdsToSend(home, chooseKin = true))
        assertEquals(setOf("k1", "k2"), choice.toggle("k2", home).selectedIds)
    }

    // ── #2032: the Kin line on a visit's detail ─────────────────────────────

    @Test
    fun `the Kin line names the Kin the visit stores`() {
        assertEquals("Pepper", visitKinLine(listOf("k1"), listOf("Pepper")))
        assertEquals("Biscuit, Gravy", visitKinLine(listOf("k1", "k2"), listOf("Biscuit", " Gravy ")))
    }

    @Test
    fun `a visit that names nobody reads as the whole home, never a blank line`() {
        assertEquals("Every Kin in the home", visitKinLine(emptyList(), emptyList()))
        assertEquals("Every Kin in the home", visitKinLine(emptyList(), listOf("", "  ")))
    }

    // #2404: a Kin with no name on file is stored as an id alone. The line read
    // the names only, so a booking narrowed to that Kin read as the whole home.
    @Test
    fun `a visit narrowed to Kin with no name on file counts them, never the whole home`() {
        assertEquals("1 (names not on file)", visitKinLine(listOf("k2"), emptyList()))
        assertEquals("2 (names not on file)", visitKinLine(listOf("k2", "k3"), listOf("", " ")))
    }

    @Test
    fun `a visit with more Kin than names lists the names and counts the rest`() {
        assertEquals("Biscuit · 1 without a name on file", visitKinLine(listOf("k1", "k2"), listOf("Biscuit")))
        assertEquals(
            "Biscuit, Gravy · 2 without a name on file",
            visitKinLine(listOf("k1", "k2", "k3", "k4"), listOf("Biscuit", "", "Gravy")),
        )
    }

    @Test
    fun `names the visit stores without ids are still named, with nobody counted`() {
        assertEquals("Biscuit, Gravy", visitKinLine(emptyList(), listOf("Biscuit", "Gravy")))
        assertEquals("Biscuit, Gravy", visitKinLine(listOf("k1"), listOf("Biscuit", "Gravy")))
    }

    // What the form stores for a narrowed choice is what the line reads back.
    @Test
    fun `a narrowed choice the form stores reads back as that choice`() {
        val nameless = listOf(RosterKin("k1", "Biscuit"), RosterKin("k2", null))
        val onlyNameless = KinChoice().toggle("k1", nameless)
        assertEquals(
            "1 (names not on file)",
            visitKinLine(onlyNameless.kinIdsToSend(nameless, true), onlyNameless.kinNamesToStore(nameless, true)),
        )
        val everyKin = KinChoice()
        assertEquals(
            "Every Kin in the home",
            visitKinLine(everyKin.kinIdsToSend(nameless, true), everyKin.kinNamesToStore(nameless, true)),
        )
    }
}
