package com.tribetails.auntieos.domain

/**
 * Which Kin a visit covers (#1822, #1862, #2032; operator ruling 2026-11-12).
 *
 * EVERY VISIT COVERS EVERY KIN. That is the default: New booking and the
 * Schedule's New Booking form name the household's Kin and offer nothing to
 * tick. With the "Visits: choose Kin" feature flag on, each Kin is a chip,
 * every one chosen to begin with.
 *
 * The Kin, and whether they can be chosen, are the server's answer
 * (`getHouseholdKinRoster`), the same list the visit is stored with and the
 * admin web app, the desktop console and both MyTribe apps draw. The admin
 * apps used to list the admin Kin records themselves, which is how one booking
 * read six Kin on the form and three on the request.
 *
 * Pure, so the rules are tested without a screen. The web mirror is
 * auntieos-admin/src/lib/kinChoice.ts.
 */

/** One Kin a visit can cover: the server's roster entry. */
data class RosterKin(val id: String, val name: String?) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: "Unnamed Kin"
}

/** The household's Kin in care, and whether specific ones may be chosen. */
data class HouseholdKinRoster(val kin: List<RosterKin>, val chooseKin: Boolean)

/**
 * Decodes the callable's answer. Null when it carries no `kin` list (an older
 * server), so the form says the Kin could not be loaded rather than drawing a
 * household with none. Choosing is on only when the server says exactly `true`.
 */
fun householdKinRosterOf(raw: Map<String, Any?>?): HouseholdKinRoster? {
    val rows = raw?.get("kin") as? List<*> ?: return null
    val kin = rows.mapNotNull { row ->
        val o = row as? Map<*, *> ?: return@mapNotNull null
        val id = (o["id"] as? String)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        RosterKin(id, (o["name"] as? String)?.takeIf { it.isNotBlank() })
    }
    return HouseholdKinRoster(kin, chooseKin = raw["chooseKin"] == true)
}

/** A form's Kin choice: every Kin, or the chosen ones. */
data class KinChoice(val allKin: Boolean = true, val selectedIds: Set<String> = emptySet()) {

    /** True when the visit is for every Kin: nothing was unticked, or nothing can be. */
    fun coversAll(chooseKin: Boolean): Boolean = allKin || !chooseKin

    fun isSelected(kinId: String, chooseKin: Boolean): Boolean = coversAll(chooseKin) || kinId in selectedIds

    /** The Kin of [roster] this choice covers, in roster order. */
    fun covered(roster: List<RosterKin>, chooseKin: Boolean): List<RosterKin> =
        if (coversAll(chooseKin)) roster else roster.filter { it.id in selectedIds }

    /**
     * Ticks or unticks one Kin. Ticking the last unticked Kin is "every Kin"
     * again, so a Kin added to the home a moment later is covered too.
     */
    fun toggle(kinId: String, roster: List<RosterKin>): KinChoice {
        val ids = roster.map { it.id }
        val current = if (allKin) ids else ids.filter { it in selectedIds }
        val next = if (kinId in current) current - kinId else ids.filter { it == kinId || it in current }
        return if (next.size == ids.size) KinChoice() else KinChoice(allKin = false, selectedIds = next.toSet())
    }

    /**
     * The `kinIds` a visit call sends. Empty means every Kin: the server stores
     * the whole roster for it. Always empty unless Kin can be chosen, so a form
     * left open across a flag change cannot send a stale narrowing.
     */
    fun kinIdsToSend(roster: List<RosterKin>, chooseKin: Boolean): List<String> =
        if (coversAll(chooseKin) || roster.isEmpty()) emptyList() else covered(roster, chooseKin).map { it.id }

    /**
     * The names stored beside [kinIdsToSend] on a record this app writes itself.
     * Empty whenever the ids are, so a record for every Kin names nobody and a
     * narrowed one never reads as "Every Kin in the home". A Kin with no name
     * on file adds none.
     */
    fun kinNamesToStore(roster: List<RosterKin>, chooseKin: Boolean): List<String> =
        if (coversAll(chooseKin) || roster.isEmpty()) emptyList()
        else covered(roster, chooseKin).mapNotNull { k -> k.name?.takeIf { it.isNotBlank() } }
    /**
     * #2347: the `kinChosenWithFlagOn` stamp a draft this app writes carries.
     * True exactly when the form drew the picker, i.e. choosing Kin is on, so
     * the server keeps the draft's Kin at approval even if choosing is
     * switched off before then. A draft saved with choosing off says false,
     * and is booked for every Kin whatever ids it names.
     */
    fun chosenWithFlagOn(chooseKin: Boolean): Boolean = chooseKin

    /** True when Kin can be chosen and none is: the one state a form must not submit. */
    fun noneChosen(roster: List<RosterKin>, chooseKin: Boolean): Boolean =
        chooseKin && roster.isNotEmpty() && covered(roster, chooseKin).isEmpty()
}

/**
 * #2032: the "Kin" line on a visit's detail, from what the visit itself
 * stores. Names where it has them; a count where it has only ids; and for a
 * visit that names nobody, the rule every visit is made under.
 *
 * #2404: the ids are read as well as the names. A Kin with no name on file is
 * stored as an id alone, so a booking narrowed to that Kin read "Every Kin in
 * the home" from its names. Same words as the admin web app (`visitFacts.ts`)
 * and the desktop console (`KinRoster.kt`).
 */
fun visitKinLine(kinIds: List<String>, kinNames: List<String>): String {
    val names = kinNames.map { it.trim() }.filter { it.isNotEmpty() }
    if (names.isEmpty()) {
        return if (kinIds.isEmpty()) "Every Kin in the home" else "${kinIds.size} (names not on file)"
    }
    val unnamed = (kinIds.size - names.size).coerceAtLeast(0)
    val joined = names.joinToString(", ")
    return if (unnamed > 0) "$joined · $unnamed without a name on file" else joined
}
