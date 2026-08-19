package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.TrainingDocument

/**
 * Who a Tribal Intel entry is about, and what to call them on screen.
 *
 * Kept as pure functions rather than inline Compose logic so both the list row
 * and the create/edit form read the SAME classification, and so it has unit
 * coverage. The web admin carries the identical module at
 * `auntieos-admin/src/lib/tribalIntelFormat.ts` and the labels below are
 * byte-identical to its own, so the same entry is described with the same word
 * on both clients.
 *
 * ── THE THREE TARGETS (issue #393) ────────────────────────────────────────
 * The stored `targetType` used to hold two values, KINFOLK and KIN, and this
 * screen labelled the KINFOLK chip "Whole household". One word did two jobs, so
 * an entry about one human client displayed as an entry about everyone under
 * that roof. Per the operator ruling there are three, and the words mean what
 * this codebase already means by them:
 *
 *   HOUSEHOLD  the whole family: every kinfolk and every kin under one roof.
 *   KINFOLK    one human client.
 *   KIN        one animal.
 *
 * `targetKinfolkId` anchors all three (a family shares its id with its kinfolk
 * record), and `targetKinId` narrows to one animal.
 */
enum class TribalIntelTargetKind { HOUSEHOLD, KINFOLK, KIN }

/** A resolved target: what kind of thing, and the id of the one it names ("" when the entry names nobody). */
data class TribalIntelTarget(val kind: TribalIntelTargetKind, val id: String)

/** The stored enum values the callables accept, in the order the form offers them. Widest first. */
val TRIBAL_INTEL_TARGET_TYPES: List<String> = listOf("HOUSEHOLD", "KINFOLK", "KIN")

/** The default target for a new entry: the widest one, so an untouched picker never names a person. */
const val TRIBAL_INTEL_DEFAULT_TARGET_TYPE: String = "HOUSEHOLD"

/** What each target covers, in one line, beside the chips that pick it. */
const val TRIBAL_INTEL_TARGET_HINT: String =
    "Household is everyone under one roof. Kinfolk is one person. Kin is one animal."

/** The chip copy for a stored target type. Unknown text falls back to the household word, same as the reader. */
fun targetTypeLabel(targetType: String): String = targetKindLabel(targetKindOf(targetType))

/** The word each target goes by on screen. */
fun targetKindLabel(kind: TribalIntelTargetKind): String = when (kind) {
    TribalIntelTargetKind.HOUSEHOLD -> "Household"
    TribalIntelTargetKind.KINFOLK -> "Kinfolk"
    TribalIntelTargetKind.KIN -> "Kin"
}

/** Stored text to kind, by POSITIVE match. Anything unrecognized is the household, never a guess at a person. */
private fun targetKindOf(targetType: String): TribalIntelTargetKind =
    when (targetType.trim().uppercase()) {
        "KIN" -> TribalIntelTargetKind.KIN
        "KINFOLK" -> TribalIntelTargetKind.KINFOLK
        else -> TribalIntelTargetKind.HOUSEHOLD
    }

/**
 * Classifies one entry's stored target.
 *
 * THE READ-TIME DEFAULT IS HOUSEHOLD, and it is a deliberate choice about
 * documents this change did not write:
 *
 *  - A row from the NDJSON migration import carries `kinfolkRef` and no
 *    `targetType` at all. The only thing it names is the household anchor, so
 *    household is the widest honest reading; calling it a kinfolk would claim
 *    the note is about one person when the document never said so. It is also
 *    what the nightly reconcile pipeline already does with such a row.
 *  - A KIN row whose `targetKinId` is blank names no animal, so it cannot
 *    render as one. Same fall-through.
 *
 * Nothing is backfilled; a legacy row gains an explicit `targetType` the first
 * time an operator saves it.
 */
fun tribalIntelTarget(
    targetType: String,
    targetKinfolkId: String,
    targetKinId: String,
    kinfolkRef: String,
): TribalIntelTarget {
    // Pre-spec-23 rows carry only `kinfolkRef`, so it is the anchor of last resort.
    val named = targetKinfolkId.trim()
    val anchor = if (named.isEmpty()) kinfolkRef.trim() else named
    val kinId = targetKinId.trim()

    return when (targetKindOf(targetType)) {
        TribalIntelTargetKind.KIN ->
            if (kinId.isNotEmpty()) TribalIntelTarget(TribalIntelTargetKind.KIN, kinId)
            else TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, anchor)
        TribalIntelTargetKind.KINFOLK ->
            if (anchor.isNotEmpty()) TribalIntelTarget(TribalIntelTargetKind.KINFOLK, anchor)
            else TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, anchor)
        TribalIntelTargetKind.HOUSEHOLD -> TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, anchor)
    }
}

/** The same classification straight off a document. */
fun tribalIntelTarget(doc: TrainingDocument): TribalIntelTarget =
    tribalIntelTarget(doc.targetType, doc.targetKinfolkId, doc.targetKinId, doc.kinfolkRef)

// ── the stale target (issue #460) ────────────────────────────────────────

/** What a reference points at, for the wording of the stale-target message. */
enum class TribalIntelTargetNoun { HOUSEHOLD, KINFOLK, KIN }

private fun targetNounThing(noun: TribalIntelTargetNoun): String = when (noun) {
    TribalIntelTargetNoun.HOUSEHOLD -> "household on the roster"
    TribalIntelTargetNoun.KINFOLK -> "kinfolk on the roster"
    TribalIntelTargetNoun.KIN -> "pet on the roster"
}

private fun targetNounAction(noun: TribalIntelTargetNoun): String = when (noun) {
    TribalIntelTargetNoun.HOUSEHOLD -> "Pick the right household"
    TribalIntelTargetNoun.KINFOLK -> "Pick the right kinfolk"
    TribalIntelTargetNoun.KIN -> "Pick the right pet"
}

/**
 * The message for a stored reference the roster cannot place, or null when
 * there is nothing wrong with it. Byte-identical to the web admin's
 * `tribalIntelStaleTargetMessage` (`lib/tribalIntelDraftSchema.ts`), so the same
 * entry is complained about in the same words on both clients.
 *
 * WHY THIS EXISTS (issue #460): rows imported from the old system store a
 * person's NAME where newer rows store an id. The editor seeded its dropdown
 * with that name, `kinfolkDirectory.firstOrNull { it.id == selectedKinfolkId }`
 * found nothing, and the field fell back to its placeholder — so the form showed
 * a BLANK target for a note that plainly named somebody, while `hasTarget` still
 * read the name as a filled-in target and let it be saved straight back. The
 * value stays on screen instead, and the save is blocked.
 *
 * NULL WHILE THE ROSTER IS EMPTY, deliberately: an empty directory means it has
 * not loaded yet, not that every id is stale. Without this guard every entry
 * opened in that first moment would accuse its own target of being broken.
 */
fun tribalIntelStaleTargetMessage(
    storedId: String,
    rosterIds: List<String>,
    noun: TribalIntelTargetNoun,
): String? {
    val id = storedId.trim()
    if (id.isEmpty()) return null
    if (rosterIds.isEmpty()) return null
    if (rosterIds.contains(id)) return null
    return "This entry points at \"$id\", which is not a ${targetNounThing(noun)}. " +
        "${targetNounAction(noun)}. It cannot be saved as it stands."
}

/** The label a stale value is shown under, so an operator can read what the note was filed against. */
fun tribalIntelStaleOptionLabel(storedId: String): String = "Unresolved: \"${storedId.trim()}\""

/** The noun the anchor picker goes by for a stored target type. */
fun anchorNounFor(targetType: String): TribalIntelTargetNoun =
    if (targetType.trim().uppercase() == "KINFOLK") TribalIntelTargetNoun.KINFOLK
    else TribalIntelTargetNoun.HOUSEHOLD

/** A kinfolk's own name, or a named fallback so a row never reads as blank. */
fun kinfolkDisplayName(kf: Kinfolk): String =
    "${kf.firstName} ${kf.lastName}".trim().ifBlank { "Unnamed Kinfolk" }

/**
 * Household display label from a surname, e.g. "the Halbrooks", sibilant
 * pluralization included ("Brooks" -> "the Brookses"). Mirrors the web admin's
 * `householdLabel` in `api/directory.ts`.
 */
fun householdLabel(lastName: String): String {
    val name = lastName.trim()
    if (name.isEmpty()) return ""
    val plural = if (Regex("(s|x|z|ch|sh)$").containsMatchIn(name.lowercase())) "${name}es" else "${name}s"
    return "the $plural"
}

/**
 * Resolves a target to the name of the thing it points at.
 *
 * Falls back to the raw id when the roster holds no match, which is honest
 * rather than blank: an entry pointing at a household that has since been
 * deleted still shows WHICH id it pointed at. Returns null only when the entry
 * names nothing at all, so the row draws no target line rather than a label
 * with an empty tail.
 */
fun tribalIntelTargetName(
    target: TribalIntelTarget,
    kinfolk: List<Kinfolk>,
    kin: List<Kin>,
): String? {
    if (target.id.isEmpty()) return null

    if (target.kind == TribalIntelTargetKind.KIN) {
        val match = kin.firstOrNull { it.id == target.id } ?: return target.id
        return match.name.trim().ifBlank { target.id }
    }

    val match = kinfolk.firstOrNull { it.id == target.id } ?: return target.id
    if (target.kind == TribalIntelTargetKind.KINFOLK) return kinfolkDisplayName(match)
    // A household is named after the surname it shares. A kinfolk with no last
    // name on file has no household label to build, so their own name carries
    // the row rather than an empty string.
    return householdLabel(match.lastName).ifBlank { kinfolkDisplayName(match) }
}

/** "Household: the Halbrooks" / "Kinfolk: Jane Halbrook" / "Kin: Rufus", or null when the entry names nobody. */
fun tribalIntelTargetLabel(
    doc: TrainingDocument,
    kinfolk: List<Kinfolk>,
    kin: List<Kin>,
): String? {
    val target = tribalIntelTarget(doc)
    val name = tribalIntelTargetName(target, kinfolk, kin) ?: return null
    return "${targetKindLabel(target.kind)}: $name"
}
