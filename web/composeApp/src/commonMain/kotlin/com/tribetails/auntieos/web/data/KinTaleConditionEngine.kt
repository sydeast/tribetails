package com.tribetails.auntieos.web.data

/**
 * Conditional-checklist engine for KinTale templates. A [ChecklistItem] with no
 * conditions is always shown; with conditions, it is only shown for kin / visits
 * that satisfy ALL of them (AND).
 *
 * This is a direct port of the Android `KinTaleTemplateEngine` so a template
 * authored on either platform produces the same kinfolk-facing report. The two
 * engines MUST stay in lock-step; [KinTaleConditionEngineTest] pins the behavior.
 *
 * Unknown enum values (a newer app wrote a source/op this build doesn't know)
 * evaluate as "always visible" rather than throwing - a forward-compatible,
 * fail-open default that never hides an item because of a parsing gap.
 */
object KinTaleConditionEngine {

    /** Whether a checklist item is visible at all in this session. */
    fun isChecklistItemVisible(item: ChecklistItem, session: KinCareSession, kinList: List<Kin>): Boolean {
        if (item.conditions.isEmpty()) return true
        return if (item.scope.equals("PER_PET", ignoreCase = true)) {
            // PER_PET: visible if ANY kin in the visit matches.
            kinList.any { evaluateAll(item.conditions, session, it) }
        } else {
            // PER_VISIT: evaluated once against the first kin (service-type rules
            // need no kin at all).
            evaluateAll(item.conditions, session, kinList.firstOrNull())
        }
    }

    /** For PER_PET items, the subset of kin the item actually applies to (order preserved). */
    fun applicableKinForChecklistItem(item: ChecklistItem, session: KinCareSession, kinList: List<Kin>): List<Kin> =
        if (item.conditions.isEmpty()) kinList
        else kinList.filter { evaluateAll(item.conditions, session, it) }

    private fun evaluateAll(conditions: List<FieldCondition>, session: KinCareSession, kin: Kin?): Boolean =
        conditions.all { evaluate(it, session, kin) }

    private fun evaluate(condition: FieldCondition, session: KinCareSession, kin: Kin?): Boolean {
        val source = runCatching { ConditionSource.valueOf(condition.source) }.getOrNull() ?: return true
        val op = runCatching { ConditionOp.valueOf(condition.op) }.getOrNull() ?: return true

        val actual: String = when (source) {
            ConditionSource.SERVICE_TYPE  -> session.serviceType
            ConditionSource.KIN_SPECIES   -> kin?.species ?: ""
            ConditionSource.KIN_ATTRIBUTE -> kin?.let { readAttribute(it, condition.attributeKey) } ?: ""
        }
        return matches(actual, condition.value, op)
    }

    private fun matches(actual: String, expected: String, op: ConditionOp): Boolean {
        val a = actual.trim()
        val e = expected.trim()
        return when (op) {
            ConditionOp.EQUALS     -> a.equals(e, ignoreCase = true)
            ConditionOp.NOT_EQUALS -> !a.equals(e, ignoreCase = true)
            ConditionOp.CONTAINS   -> a.contains(e, ignoreCase = true)
            ConditionOp.EXISTS     -> a.isNotBlank() && !a.equals("false", ignoreCase = true)
        }
    }

    /**
     * Maps a catalogued attribute key to its value on the kin. MUST cover every
     * key in [conditionAttributeCatalog] (guarded by the engine test) so the
     * editor can never offer a key the engine reads as blank.
     */
    private fun readAttribute(kin: Kin, key: String): String = when (key) {
        "medicationHealthNotes" -> kin.medicationHealthNotes
        "vaccinations"          -> kin.vaccinations
        "vetInfo"               -> kin.vetInfo
        "feedingBrand"          -> kin.feedingBrand
        "trainingCommands"      -> kin.trainingCommands
        "routine"               -> kin.routine
        "checklist"             -> kin.checklist
        "reactive"              -> kin.reactive.toString()
        "spayedNeutered"        -> kin.spayedNeutered.toString()
        "officeNotes"           -> kin.officeNotes
        "colorMarkings"         -> kin.colorMarkings
        else                    -> ""
    }
}

/** A kin attribute an operator can build a KIN_ATTRIBUTE condition on. */
data class ConditionAttribute(val key: String, val label: String)

/**
 * The canonical list of kin attributes the condition editor offers. This is the
 * single source of truth: every key here must be readable by
 * [KinTaleConditionEngine] (asserted in the engine test), and both platform
 * editors render this same list so they cannot drift.
 */
val conditionAttributeCatalog: List<ConditionAttribute> = listOf(
    ConditionAttribute("medicationHealthNotes", "Medication / health notes"),
    ConditionAttribute("vaccinations",          "Vaccinations"),
    ConditionAttribute("vetInfo",               "Vet info"),
    ConditionAttribute("feedingBrand",          "Feeding brand"),
    ConditionAttribute("trainingCommands",      "Training commands"),
    ConditionAttribute("routine",               "Routine"),
    ConditionAttribute("checklist",             "Care checklist"),
    ConditionAttribute("reactive",              "Reactive"),
    ConditionAttribute("spayedNeutered",        "Spayed / neutered"),
    ConditionAttribute("officeNotes",           "Office notes"),
    ConditionAttribute("colorMarkings",         "Color / markings"),
)

/**
 * Editor helper: whether this condition's `source` picks a kin attribute (and so
 * the editor shows the attribute dropdown). Unknown sources do not, matching the
 * fail-open engine default.
 */
fun conditionUsesAttributeKey(sourceName: String): Boolean =
    sourceName == ConditionSource.KIN_ATTRIBUTE.name

/**
 * Editor helper: whether this condition's `op` compares against a typed value (and
 * so the editor shows the value field). EXISTS needs no value; every other op -
 * including a forward-compatible unknown one - does.
 */
fun conditionUsesValueInput(opName: String): Boolean =
    opName != ConditionOp.EXISTS.name

/**
 * A human-readable, kinfolk-safe summary of one condition, rendered under the
 * checklist item in the editor (e.g. "Only show when the pet's species is Cat").
 * Falls back to a neutral label for forward-compatible unknown enum values.
 */
fun conditionSummary(c: FieldCondition): String {
    val source = runCatching { ConditionSource.valueOf(c.source) }.getOrNull()
    val op = runCatching { ConditionOp.valueOf(c.op) }.getOrNull()
    if (source == null || op == null) return "Custom condition"

    val value = c.value.trim().ifBlank { "(blank)" }

    if (source == ConditionSource.KIN_ATTRIBUTE) {
        val label = conditionAttributeCatalog.firstOrNull { it.key == c.attributeKey }?.label
            ?: c.attributeKey.ifBlank { "an attribute" }
        return when (op) {
            ConditionOp.EXISTS     -> "Only show when the pet has $label"
            ConditionOp.EQUALS     -> "Only show when the pet's $label is $value"
            ConditionOp.NOT_EQUALS -> "Only show when the pet's $label is not $value"
            ConditionOp.CONTAINS   -> "Only show when the pet's $label contains $value"
        }
    }

    val subject = when (source) {
        ConditionSource.KIN_SPECIES  -> "the pet's species"
        ConditionSource.SERVICE_TYPE -> "the service type"
        ConditionSource.KIN_ATTRIBUTE -> "the attribute" // unreachable; handled above
    }
    return when (op) {
        ConditionOp.EQUALS     -> "Only show when $subject is $value"
        ConditionOp.NOT_EQUALS -> "Only show when $subject is not $value"
        ConditionOp.CONTAINS   -> "Only show when $subject contains $value"
        ConditionOp.EXISTS     -> "Only show when $subject is set"
    }
}
