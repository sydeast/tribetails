package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinRoster
import com.kinfolk.portal.portal.KinStatus

/**
 * Which Kin a booking covers (#1822, #1862, operator ruling 2026-11-12).
 *
 * EVERY BOOKING COVERS EVERY KIN. That is the default, and unless the office
 * has switched choosing Kin on, step 1 of the wizard names the household's Kin
 * and offers nothing to tick. With it on, each Kin is a tick row, every one
 * ticked to begin with.
 *
 * Pure, so the rules are tested without a screen. The web mirror is step 1 of
 * mytribe/web/src/screens/BookingWizard.tsx.
 */

/** What step 1 draws for one Kin. A Kin the office added may have a name and nothing else. */
data class BookingKin(
    val id: String,
    val name: String?,
    val species: String? = null,
    val breed: String? = null,
    val ageYears: Double? = null,
) {
    /** "Labrador • 4 yrs", or blank when neither is on file. */
    val subtitle: String
        get() = listOfNotNull(breed ?: species, ageYears?.let { "${it.toInt()} yrs" }).joinToString(" • ")

    val label: String get() = name?.takeIf { it.isNotBlank() } ?: "Unnamed Kin"
}

/**
 * The Kin this booking can cover. The server's [roster] decides who is on it
 * and in what order; [own] (the household's Kin cards) only fills in each
 * one's breed and age. When the roster could not be read the wizard still
 * opens on the household's own active Kin, and the server books the whole home.
 */
fun bookingKin(own: List<Kin>, roster: KinRoster?): List<BookingKin> {
    val active = own.filter { it.status == KinStatus.Active }
    fun card(k: Kin) = BookingKin(k.id, k.name, k.species, k.breed, k.ageYears)
    if (roster == null) return active.map(::card)
    val byId = active.associateBy { it.id }
    return roster.kin.map { r -> byId[r.id]?.let(::card) ?: BookingKin(id = r.id, name = r.name) }
}

/** The wizard's Kin choice: every Kin, or the ticked ones. */
data class KinChoice(val allKin: Boolean = true, val selectedIds: Set<String> = emptySet()) {

    /** True when the booking is for every Kin: nothing was unticked, or nothing can be. */
    fun coversAll(chooseKin: Boolean): Boolean = allKin || !chooseKin

    fun isSelected(kinId: String, chooseKin: Boolean): Boolean = coversAll(chooseKin) || kinId in selectedIds

    /** The Kin of [kin] this choice covers, in roster order. */
    fun covered(kin: List<BookingKin>, chooseKin: Boolean): List<BookingKin> =
        if (coversAll(chooseKin)) kin else kin.filter { it.id in selectedIds }

    /** The `kinIds` the request carries. */
    fun kinIds(kin: List<BookingKin>, chooseKin: Boolean): List<String> = covered(kin, chooseKin).map { it.id }

    /** Step 1 can be left only with a Kin to book for. */
    fun canAdvance(kin: List<BookingKin>, chooseKin: Boolean): Boolean = covered(kin, chooseKin).isNotEmpty()

    /**
     * Ticks or unticks one Kin. Ticking the last unticked Kin is "every Kin"
     * again, so a Kin added to the home a moment later is covered too.
     */
    fun toggle(kinId: String, kin: List<BookingKin>): KinChoice {
        val ids = kin.map { it.id }
        val current = if (allKin) ids else ids.filter { it in selectedIds }
        val next = if (kinId in current) current - kinId else ids.filter { it == kinId || it in current }
        return if (next.size == ids.size) KinChoice() else KinChoice(allKin = false, selectedIds = next.toSet())
    }
}
