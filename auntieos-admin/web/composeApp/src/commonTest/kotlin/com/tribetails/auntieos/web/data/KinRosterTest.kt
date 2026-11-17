package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Which Kin a visit covers, desktop console half (#1822, #1862, #2032).
 * Operator ruling 2026-11-12: every visit covers every Kin, and choosing
 * specific Kin is a feature flag that is off by default.
 *
 * The web mirror is auntieos-admin/src/lib/kinChoice.test.ts.
 */
class KinRosterTest {

    private val buddy = RosterKin("k1", "Buddy")
    private val willow = RosterKin("k2", "Willow")
    private val maple = RosterKin("k3", null)
    private val home = listOf(buddy, willow, maple)

    private fun ready(chooseKin: Boolean, kin: List<RosterKin> = home) =
        KinRosterState.Ready(HouseholdKinRoster(kin, chooseKin))

    // ── the server's answer ─────────────────────────────────────────────────

    @Test
    fun `decodes the Kin in the server's order and whether they can be chosen`() {
        val roster = householdKinRosterOf(
            """{"kin":[{"id":"k2","name":"Willow"},{"id":"k1","name":"Buddy","adminId":"flat1"}],"chooseKin":true}""",
        )
        assertEquals(HouseholdKinRoster(listOf(willow, buddy), chooseKin = true), roster)
    }

    @Test
    fun `choosing is on only when the server says exactly true`() {
        for (answer in listOf("""{"kin":[]}""", """{"kin":[],"chooseKin":false}""", """{"kin":[],"chooseKin":null}""", """{"kin":[],"chooseKin":"yes"}""")) {
            assertEquals(false, householdKinRosterOf(answer)?.chooseKin, answer)
        }
    }

    @Test
    fun `a Kin with no name is kept, a row with no id is dropped`() {
        val roster = householdKinRosterOf(
            """{"kin":[{"id":"k3","name":null},{"id":"k4","name":"  "},{"name":"No Id"},{"id":""},7],"chooseKin":false}""",
        )
        assertEquals(listOf(RosterKin("k3", null), RosterKin("k4", null)), roster?.kin)
    }

    @Test
    fun `an answer with no Kin list is no answer, never an empty home`() {
        assertNull(householdKinRosterOf("""{"ok":true}"""))
        assertNull(householdKinRosterOf("""{"kin":"none"}"""))
        assertNull(householdKinRosterOf("not json"))
        assertNull(householdKinRosterOf(""))
    }

    @Test
    fun `a Kin with no name on file is never drawn as a blank`() {
        assertEquals("Unnamed Kin", maple.label)
        assertEquals("Unnamed Kin", RosterKin("k9", "  ").label)
        assertEquals("Buddy", buddy.label)
    }

    // ── whether there is anything to choose ─────────────────────────────────

    @Test
    fun `Kin can be chosen only when the server says so and there is a Kin`() {
        assertTrue(ready(chooseKin = true).canChoose)
        assertFalse(ready(chooseKin = false).canChoose)
        assertFalse(ready(chooseKin = true, kin = emptyList()).canChoose)
    }

    @Test
    fun `nothing can be chosen while the answer is unknown`() {
        assertFalse(KinRosterState.Idle.canChoose)
        assertFalse(KinRosterState.Loading.canChoose)
        assertFalse(KinRosterState.Failed.canChoose)
    }

    // ── choosing off, the default ───────────────────────────────────────────

    @Test
    fun `with choosing off nothing is named and the server books every Kin`() {
        assertEquals(emptyList(), KinChoice().kinIdsToSend(ready(chooseKin = false)))
        // Even a narrowing held from before the flag went off is not sent.
        val stale = KinChoice(allKin = false, selectedIds = setOf("k2"))
        assertEquals(emptyList(), stale.kinIdsToSend(ready(chooseKin = false)))
        assertFalse(KinChoice(allKin = false).noneChosen(ready(chooseKin = false)))
    }

    @Test
    fun `when the Kin could not be loaded nothing is named and the form is not blocked`() {
        val stale = KinChoice(allKin = false, selectedIds = setOf("k2"))
        assertEquals(emptyList(), stale.kinIdsToSend(KinRosterState.Failed))
        assertFalse(KinChoice(allKin = false).noneChosen(KinRosterState.Failed))
        assertFalse(KinChoice(allKin = false).noneChosen(KinRosterState.Loading))
    }

    // ── choosing on ─────────────────────────────────────────────────────────

    @Test
    fun `with choosing on every Kin starts ticked, and left alone nothing is named`() {
        val start = KinChoice()
        assertTrue(home.all { start.isSelected(it.id) })
        assertEquals(emptyList(), start.kinIdsToSend(ready(chooseKin = true)))
    }

    @Test
    fun `unticking a Kin sends only the Kin left ticked, in roster order`() {
        val choice = KinChoice().toggle("k2", home)
        assertFalse(choice.isSelected("k2"))
        assertEquals(listOf("k1", "k3"), choice.kinIdsToSend(ready(chooseKin = true)))
    }

    @Test
    fun `a narrowed choice stores the names of the Kin left ticked, and every Kin stores none`() {
        val choice = KinChoice().toggle("k2", home)
        val expected = home.filter { it.id != "k2" }.mapNotNull { it.name }
        assertEquals(expected, choice.kinNamesToStore(ready(chooseKin = true)))
        assertEquals(emptyList(), KinChoice().kinNamesToStore(ready(chooseKin = true)))
        assertEquals(emptyList(), choice.kinNamesToStore(ready(chooseKin = false)))
        assertEquals(emptyList(), choice.kinNamesToStore(KinRosterState.Failed))
    }
    @Test
    fun `ticking the last unticked Kin is every Kin again`() {
        assertEquals(KinChoice(), KinChoice().toggle("k2", home).toggle("k2", home))
    }

    @Test
    fun `with no Kin ticked the form must not submit`() {
        val none = KinChoice().toggle("k1", home).toggle("k2", home).toggle("k3", home)
        assertTrue(none.noneChosen(ready(chooseKin = true)))
        assertFalse(KinChoice().noneChosen(ready(chooseKin = true)))
    }

    @Test
    fun `a ticked id that is no longer on the roster is dropped`() {
        val choice = KinChoice(allKin = false, selectedIds = setOf("gone", "k1"))
        assertEquals(listOf("k1"), choice.kinIdsToSend(ready(chooseKin = true)))
        assertEquals(setOf("k1", "k2"), choice.toggle("k2", home).selectedIds)
    }

    // ── #2032: the Kin line on Visit detail ─────────────────────────────────

    @Test
    fun `the Kin line names the Kin the visit stores`() {
        assertEquals("Pepper", visitKinLine(listOf("k3"), listOf("Pepper")))
        assertEquals("Biscuit, Gravy", visitKinLine(listOf("k1", "k2"), listOf("Biscuit", "Gravy")))
    }

    @Test
    fun `a Kin with no stored name is counted, never dropped`() {
        assertEquals("Biscuit · 1 without a name on file", visitKinLine(listOf("k1", "k2"), listOf("Biscuit")))
        assertEquals("2 (names not on file)", visitKinLine(listOf("k1", "k2"), emptyList()))
        assertEquals("2 (names not on file)", visitKinLine(listOf("k1", "k2"), listOf(" ", "")))
    }

    @Test
    fun `an old visit that names nobody reads as the whole home, never a blank or an id`() {
        assertEquals("Every Kin in the home", visitKinLine(emptyList(), emptyList()))
    }

    @Test
    fun `names stored without ids are still shown`() {
        assertEquals("Biscuit", visitKinLine(emptyList(), listOf("Biscuit")))
    }
}
