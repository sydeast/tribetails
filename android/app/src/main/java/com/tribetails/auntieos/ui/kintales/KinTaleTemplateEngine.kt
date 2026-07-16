package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.ConditionOp
import com.tribetails.auntieos.data.model.ConditionSource
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.MoodOption

// Evaluates whether a checklist item is visible for a given kin within a
// session. Conditions are AND-ed; an empty condition list means "always
// visible".
object KinTaleTemplateEngine {

    /** Whether a checklist item is visible at all in this session (any kin matches for PER_PET). */
    fun isChecklistItemVisible(item: ChecklistItem, session: KinCareSession, kinList: List<Kin>): Boolean {
        if (item.conditions.isEmpty()) return true
        val scope = runCatching { ChecklistScope.valueOf(item.scope) }.getOrDefault(ChecklistScope.PER_PET)
        return if (scope == ChecklistScope.PER_PET) {
            kinList.any { evaluateAll(item.conditions, session, it) }
        } else {
            evaluateAll(item.conditions, session, kinList.firstOrNull())
        }
    }

    /** For PER_PET checklist items, the kin the item applies to. */
    fun applicableKinForChecklistItem(item: ChecklistItem, session: KinCareSession, kinList: List<Kin>): List<Kin> =
        if (item.conditions.isEmpty()) kinList
        else kinList.filter { evaluateAll(item.conditions, session, it) }

    private fun evaluateAll(conditions: List<FieldCondition>, session: KinCareSession, kin: Kin?): Boolean =
        conditions.all { evaluate(it, session, kin) }

    private fun evaluate(condition: FieldCondition, session: KinCareSession, kin: Kin?): Boolean {
        val source = runCatching { ConditionSource.valueOf(condition.source) }.getOrNull() ?: return true
        val op = runCatching { ConditionOp.valueOf(condition.op) }.getOrNull() ?: return true

        val actual: String = when (source) {
            ConditionSource.SERVICE_TYPE -> session.serviceType
            ConditionSource.KIN_SPECIES  -> kin?.species ?: ""
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

// -----------------------------------------------------------------------------
// Condition editor support (mirrors the web KinTaleConditionEngine.kt helpers so
// both platform editors offer the same attributes + render the same summaries).
// -----------------------------------------------------------------------------

/** A kin attribute an operator can build a KIN_ATTRIBUTE condition on. */
data class ConditionAttribute(val key: String, val label: String)

/**
 * Canonical kin-attribute catalog the condition editor offers. Single source of
 * truth: every key must be readable by [KinTaleTemplateEngine] (asserted in the
 * engine test) and matches the web catalog so the two editors cannot drift.
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

/** Editor helper: whether this condition's source picks a kin attribute (shows the attribute dropdown). */
fun conditionUsesAttributeKey(sourceName: String): Boolean =
    sourceName == ConditionSource.KIN_ATTRIBUTE.name

/** Editor helper: whether this condition's op compares against a typed value (shows the value field). */
fun conditionUsesValueInput(opName: String): Boolean =
    opName != ConditionOp.EXISTS.name

/**
 * Human-readable, kinfolk-safe summary of one condition, rendered under the
 * checklist item in the editor (e.g. "Only show when the pet's species is Cat").
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
        ConditionSource.KIN_SPECIES   -> "the pet's species"
        ConditionSource.SERVICE_TYPE  -> "the service type"
        ConditionSource.KIN_ATTRIBUTE -> "the attribute" // unreachable; handled above
    }
    return when (op) {
        ConditionOp.EQUALS     -> "Only show when $subject is $value"
        ConditionOp.NOT_EQUALS -> "Only show when $subject is not $value"
        ConditionOp.CONTAINS   -> "Only show when $subject contains $value"
        ConditionOp.EXISTS     -> "Only show when $subject is set"
    }
}

// Built-in fallback template - used when Firestore has no matching active
// template. Demonstrates the conditional rules Auntie called out:
//   - "Litter box scooped"     → KIN_SPECIES == Cat
//   - "Water refilled (post-walk)" → SERVICE_TYPE contains "walk"
//   - "Meds given"             → KIN_ATTRIBUTE medicationHealthNotes EXISTS
//
// Items modelled after Auntie's reference screenshot from her competitor's
// product (Peed, Pooed, Fed, Fresh water provided, Medications given, Played).
object DefaultKinTaleTemplate {

    val template: KinTaleTemplate by lazy {
        KinTaleTemplate(
            id = "__default__",
            name = "Standard Visit",
            description = "Built-in default. Used when no service-specific template is configured.",
            defaultEmailMessage = "Hey y'all! Here's how today's visit went.",
            isActive = true,
            isDefault = true,

            photoShowcaseEnabled = true,
            checklistEnabled = true,
            petMoodEnabled = true,
            visitNotesEnabled = true,
            nextAppointmentEnabled = true,
            reviewBoosterEnabled = false,

            checklistItems = listOf(
                ChecklistItem(key = "peed",         text = "Peed",                scope = ChecklistScope.PER_PET.name, showWhenUnchecked = true,  order = 0),
                ChecklistItem(key = "pooed",        text = "Pooed",               scope = ChecklistScope.PER_PET.name, showWhenUnchecked = true,  order = 1),
                ChecklistItem(key = "fed",          text = "Fed",                 scope = ChecklistScope.PER_PET.name, showWhenUnchecked = false, order = 2),
                ChecklistItem(key = "fresh_water",  text = "Fresh water provided", scope = ChecklistScope.PER_PET.name, showWhenUnchecked = false, order = 3),
                ChecklistItem(
                    key = "meds_given",
                    text = "Medications given",
                    scope = ChecklistScope.PER_PET.name,
                    showWhenUnchecked = false,
                    order = 4,
                    conditions = listOf(
                        FieldCondition(
                            source = ConditionSource.KIN_ATTRIBUTE.name,
                            op = ConditionOp.EXISTS.name,
                            attributeKey = "medicationHealthNotes"
                        )
                    )
                ),
                ChecklistItem(key = "played",       text = "Played",              scope = ChecklistScope.PER_PET.name, showWhenUnchecked = false, order = 5),
                ChecklistItem(
                    key = "litter_scooped",
                    text = "Litter box scooped",
                    scope = ChecklistScope.PER_PET.name,
                    showWhenUnchecked = false,
                    order = 6,
                    conditions = listOf(
                        FieldCondition(
                            source = ConditionSource.KIN_SPECIES.name,
                            op = ConditionOp.EQUALS.name,
                            value = "Cat"
                        )
                    )
                ),
                ChecklistItem(
                    key = "walk_water_refill",
                    text = "Water refilled after walk",
                    scope = ChecklistScope.PER_PET.name,
                    showWhenUnchecked = false,
                    order = 7,
                    conditions = listOf(
                        FieldCondition(
                            source = ConditionSource.SERVICE_TYPE.name,
                            op = ConditionOp.CONTAINS.name,
                            value = "walk"
                        )
                    )
                ),
                // Per-visit items
                ChecklistItem(key = "trash_taken_out",  text = "Trash taken out",  scope = ChecklistScope.PER_VISIT.name, showWhenUnchecked = false, order = 8),
                ChecklistItem(key = "lights_off",       text = "Lights turned off", scope = ChecklistScope.PER_VISIT.name, showWhenUnchecked = false, order = 9)
            ),

            moodOptions = listOf(
                MoodOption(key = "happy",    label = "Happy",    emoji = "😊", order = 0),
                MoodOption(key = "playful",  label = "Playful",  emoji = "🐾", order = 1),
                MoodOption(key = "calm",     label = "Calm",     emoji = "😌", order = 2),
                MoodOption(key = "cuddly",   label = "Cuddly",   emoji = "🤗", order = 3),
                MoodOption(key = "anxious",  label = "Anxious",  emoji = "😟", order = 4),
                MoodOption(key = "shy",      label = "Shy",      emoji = "🙈", order = 5),
                MoodOption(key = "energetic",label = "Energetic",emoji = "⚡", order = 6),
                MoodOption(key = "sleepy",   label = "Sleepy",   emoji = "😴", order = 7)
            )
        )
    }
}
