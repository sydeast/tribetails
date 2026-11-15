package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Which Kin a visit covers (#1822, #1862, #2032; operator ruling 2026-11-12).
 *
 * EVERY VISIT COVERS EVERY KIN. That is the default: New visit names the
 * household's Kin and offers nothing to tick. With the "Visits: choose Kin"
 * feature flag on, each Kin is a tick box, every one ticked to begin with.
 *
 * The Kin, and whether they can be chosen, are the server's answer
 * (`getHouseholdKinRoster`), the same list the visit is stored with and the
 * admin web app, the admin Android app and both MyTribe apps draw. Pure, so
 * the rules are tested without a screen. The web mirror is
 * auntieos-admin/src/lib/kinChoice.ts.
 */

/** One Kin a visit can cover: the server's roster entry. */
data class RosterKin(val id: String, val name: String?) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: "Unnamed Kin"
}

/** The household's Kin in care, and whether specific ones may be chosen. */
data class HouseholdKinRoster(val kin: List<RosterKin>, val chooseKin: Boolean)

private val rosterJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decodes the callable's answer. Null when it carries no `kin` list (an older
 * server, or not JSON at all), so the form says the Kin could not be loaded
 * rather than drawing a household with none. Choosing is on only when the
 * server says exactly `true`.
 */
fun householdKinRosterOf(raw: String): HouseholdKinRoster? {
    val root = runCatching { rosterJson.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return null
    val rows = root["kin"] as? JsonArray ?: return null
    val kin = rows.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val id = runCatching { o["id"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: return@mapNotNull null
        val name = runCatching { o["name"]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }
        RosterKin(id, name)
    }
    val chooseKin = runCatching { root["chooseKin"]?.jsonPrimitive?.booleanOrNull }.getOrNull() == true
    return HouseholdKinRoster(kin, chooseKin)
}

/** The household's Kin as a form holds them while it asks the server. */
sealed interface KinRosterState {
    /** No household picked yet. */
    data object Idle : KinRosterState
    data object Loading : KinRosterState
    data class Ready(val roster: HouseholdKinRoster) : KinRosterState
    data object Failed : KinRosterState

    /** Whether specific Kin can be chosen right now. Never while the answer is unknown. */
    val canChoose: Boolean get() = this is Ready && roster.chooseKin && roster.kin.isNotEmpty()

    val kin: List<RosterKin> get() = (this as? Ready)?.roster?.kin.orEmpty()
}

/** A form's Kin choice: every Kin, or the ticked ones. */
data class KinChoice(val allKin: Boolean = true, val selectedIds: Set<String> = emptySet()) {

    fun isSelected(kinId: String): Boolean = allKin || kinId in selectedIds

    /** The Kin of [roster] this choice covers, in roster order. */
    fun covered(roster: List<RosterKin>): List<RosterKin> =
        if (allKin) roster else roster.filter { it.id in selectedIds }

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
    fun kinIdsToSend(state: KinRosterState): List<String> =
        if (allKin || !state.canChoose) emptyList() else covered(state.kin).map { it.id }

    /**
     * The names stored beside [kinIdsToSend] on a record this console writes
     * itself (a draft). Empty whenever the ids are. A Kin with no name on file
     * adds none.
     */
    fun kinNamesToStore(state: KinRosterState): List<String> =
        if (allKin || !state.canChoose) emptyList()
        else covered(state.kin).mapNotNull { k -> k.name?.takeIf { it.isNotBlank() } }
    /** True when Kin can be chosen and none is: the one state a form must not submit. */
    fun noneChosen(state: KinRosterState): Boolean = state.canChoose && covered(state.kin).isEmpty()
}

/**
 * #2032: the "Kin" line on a visit's detail, from what the visit itself
 * stores. Names where it has them; a count where it has only ids; and for a
 * visit that names nobody, the rule every visit is made under.
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
