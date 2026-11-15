package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinRoster
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.portal.RosterKin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Which Kin a booking covers, portal Android half (#1822, #1862). Operator
 * ruling 2026-11-12: every booking covers every Kin, and choosing specific Kin
 * is a feature the office switches on.
 *
 * The web mirror is "the Kin a booking covers" in
 * mytribe/web/src/screens/BookingWizard.test.tsx; both assert the same facts.
 */
class KinChoiceTest {

    private fun kin(
        id: String,
        name: String?,
        status: KinStatus = KinStatus.Active,
        breed: String? = null,
        species: String? = "dog",
        ageYears: Double? = null,
    ) = Kin(
        id = id, name = name, species = species, breed = breed, ageYears = ageYears, photoUrl = null,
        status = status, feedingInstructions = null, walkingInstructions = null, medications = null,
        allergies = null, emergencyNotes = null, sitterNotes = null,
    )

    private val buddy = kin("k1", "Buddy", breed = "Labrador Retriever", ageYears = 4.0)
    private val willow = kin("k2", "Willow", species = "cat")
    private val oldBoy = kin("k3", "Old Boy", status = KinStatus.NoLongerWithUs)

    private val home = listOf(BookingKin("k1", "Buddy"), BookingKin("k2", "Willow"), BookingKin("k3", "Maple"))

    // ── who is on the booking ───────────────────────────────────────────────

    @Test
    fun `the server's roster decides who is listed and in what order`() {
        val roster = KinRoster(listOf(RosterKin("k2", "Willow"), RosterKin("k1", "Buddy")), chooseKin = false)
        assertEquals(listOf("k2", "k1"), bookingKin(listOf(buddy, willow), roster).map { it.id })
    }

    @Test
    fun `each listed Kin keeps the breed and age from its own card`() {
        val roster = KinRoster(listOf(RosterKin("k1", "Buddy")), chooseKin = false)
        assertEquals("Labrador Retriever • 4 yrs", bookingKin(listOf(buddy), roster).single().subtitle)
    }

    @Test
    fun `a Kin the office added, with no card of its own, is listed by name`() {
        val roster = KinRoster(listOf(RosterKin("k1", "Buddy"), RosterKin("flat9", "Pepper")), chooseKin = false)
        val listed = bookingKin(listOf(buddy), roster)
        assertEquals(listOf("Buddy", "Pepper"), listed.map { it.label })
        assertEquals("", listed.last().subtitle)
    }

    @Test
    fun `a memorial Kin is never on a booking`() {
        val roster = KinRoster(listOf(RosterKin("k1", "Buddy")), chooseKin = false)
        assertEquals(listOf("k1"), bookingKin(listOf(buddy, oldBoy), roster).map { it.id })
        // The same holds when the server could not be asked.
        assertEquals(listOf("k1"), bookingKin(listOf(buddy, oldBoy), roster = null).map { it.id })
    }

    @Test
    fun `when the server cannot be asked the household's own active Kin are listed`() {
        assertEquals(listOf("k1", "k2"), bookingKin(listOf(buddy, willow), roster = null).map { it.id })
    }

    @Test
    fun `a Kin with no name on file is never drawn as a blank`() {
        assertEquals("Unnamed Kin", BookingKin("k9", null).label)
        assertEquals("Unnamed Kin", BookingKin("k9", "  ").label)
    }

    // ── choosing off, the default ───────────────────────────────────────────

    @Test
    fun `with choosing off every Kin is covered whatever the choice holds`() {
        val stale = KinChoice(allKin = false, selectedIds = setOf("k2"))
        assertTrue(stale.coversAll(chooseKin = false))
        assertEquals(listOf("k1", "k2", "k3"), stale.kinIds(home, chooseKin = false))
        assertTrue(stale.isSelected("k1", chooseKin = false))
    }

    @Test
    fun `with choosing off step 1 needs only a Kin on file`() {
        assertTrue(KinChoice().canAdvance(home, chooseKin = false))
        assertFalse(KinChoice().canAdvance(emptyList(), chooseKin = false))
    }

    // ── choosing on ─────────────────────────────────────────────────────────

    @Test
    fun `with choosing on every Kin starts ticked and all are sent`() {
        val start = KinChoice()
        assertTrue(home.all { start.isSelected(it.id, chooseKin = true) })
        assertEquals(listOf("k1", "k2", "k3"), start.kinIds(home, chooseKin = true))
    }

    @Test
    fun `unticking a Kin sends only the Kin left ticked, in roster order`() {
        val choice = KinChoice().toggle("k2", home)
        assertFalse(choice.isSelected("k2", chooseKin = true))
        assertEquals(listOf("k1", "k3"), choice.kinIds(home, chooseKin = true))
        assertFalse(choice.coversAll(chooseKin = true))
    }

    @Test
    fun `ticking the last unticked Kin is every Kin again`() {
        val choice = KinChoice().toggle("k2", home).toggle("k2", home)
        assertEquals(KinChoice(), choice)
        assertTrue(choice.coversAll(chooseKin = true))
    }

    @Test
    fun `with no Kin ticked step 1 cannot be left`() {
        val none = KinChoice().toggle("k1", home).toggle("k2", home).toggle("k3", home)
        assertEquals(emptyList(), none.kinIds(home, chooseKin = true))
        assertFalse(none.canAdvance(home, chooseKin = true))
    }

    @Test
    fun `a ticked id that is no longer on the roster is dropped`() {
        val choice = KinChoice(allKin = false, selectedIds = setOf("gone", "k1"))
        assertEquals(listOf("k1"), choice.kinIds(home, chooseKin = true))
        assertEquals(setOf("k1", "k2"), choice.toggle("k2", home).selectedIds)
    }
}
