package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable

/**
 * KinTaleTemplate - defines the dynamic shape of a visit recap (which sections
 * are on, which checklist items appear, etc.). Mirrors the Android-side model
 * so Firestore docs round-trip cleanly between platforms.
 *
 * Unchecked-checklist behavior is governed per-item by [ChecklistItem.showWhenUnchecked].
 * Default is `false` - unchecked items are *omitted* from the kinfolk-facing render
 * (Precise PetCare semantics, the chosen behavior for AuntieOS).
 */
@Serializable
data class KinTaleTemplate(
    val _id: String = "",
    val name: String = "",
    val description: String = "",
    val defaultEmailMessage: String = "I had a wonderful time caring for your furry friends! Here's how they did today.",
    val serviceTypeKeys: List<String> = emptyList(),
    val isActive: Boolean = true,
    val isDefault: Boolean = false,

    val photoShowcaseEnabled:   Boolean = true,
    val checklistEnabled:       Boolean = true,
    val petMoodEnabled:         Boolean = false,
    val visitNotesEnabled:      Boolean = true,
    val nextAppointmentEnabled: Boolean = true,
    val reviewBoosterEnabled:   Boolean = false,

    val checklistItems: List<ChecklistItem> = emptyList(),
    val moodOptions:    List<MoodOption>    = emptyList(),

    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class ChecklistItem(
    val key: String  = "",
    val text: String = "",
    val scope: String = "PER_PET",          // "PER_PET" | "PER_VISIT" - matches Android ChecklistScope
    val showWhenUnchecked: Boolean = false, // Precise semantics: unchecked → hidden in sent KinTale
    val required: Boolean = false,
    val order: Int = 0,
    // Conditional visibility. Empty = always shown. When present, the item only
    // appears for kin / visits that satisfy ALL conditions (see KinTaleConditionEngine).
    // Mirrors Android ChecklistItem.conditions so docs round-trip between platforms.
    val conditions: List<FieldCondition> = emptyList(),
)

/**
 * One conditional-visibility rule on a [ChecklistItem]. String-backed (source/op
 * hold [ConditionSource] / [ConditionOp] names) so the Firestore doc is byte-for-byte
 * compatible with the Android model and survives forward-compatibly if a newer app
 * writes an enum value this build doesn't know (unknown values evaluate as "always
 * visible" rather than throwing - see KinTaleConditionEngine).
 */
@Serializable
data class FieldCondition(
    val source: String = ConditionSource.KIN_SPECIES.name,
    val op: String = ConditionOp.EQUALS.name,
    val value: String = "",
    val attributeKey: String = "",          // which kin attribute, when source == KIN_ATTRIBUTE
)

enum class ConditionSource { KIN_SPECIES, KIN_ATTRIBUTE, SERVICE_TYPE }

enum class ConditionOp { EQUALS, NOT_EQUALS, CONTAINS, EXISTS }

@Serializable
data class MoodOption(
    val key: String   = "",
    val label: String = "",
    val emoji: String = "",
    val order: Int    = 0,
)

@Serializable
data class FieldResponse(
    val fieldKey: String = "",
    val kinId: String    = "",
    val sectionKey: String = "",
    val boolValue: Boolean? = null,
    val intValue: Int? = null,
    val stringValue: String = "",
    val mediaIds: List<String> = emptyList(),
)

/**
 * Built-in fallback template - used when no Firestore template matches the
 * session's service type. Kept identical to the Android default so a session
 * scaffolded on either platform produces the same shape.
 */
object DefaultKinTaleTemplate {
    const val ID = "__builtin_default__"

    val template = KinTaleTemplate(
        _id = ID,
        name = "Default KinTale",
        description = "Catch-all template for any service type that doesn't have its own.",
        isActive = true,
        isDefault = true,
        photoShowcaseEnabled = true,
        checklistEnabled     = true,
        petMoodEnabled       = true,
        visitNotesEnabled    = true,
        nextAppointmentEnabled = true,
        reviewBoosterEnabled = false,
        checklistItems = listOf(
            // Per-pet items
            ChecklistItem(key = "peed",     text = "Peed",                scope = "PER_PET", required = true,  order = 0),
            ChecklistItem(key = "pooed",    text = "Pooed",               scope = "PER_PET", required = true,  order = 1),
            ChecklistItem(key = "fed",      text = "Fed",                 scope = "PER_PET", order = 2),
            ChecklistItem(key = "water",    text = "Fresh water provided",scope = "PER_PET", order = 3),
            ChecklistItem(key = "meds",     text = "Medications given",   scope = "PER_PET", order = 4),
            ChecklistItem(key = "play",     text = "Playtime provided",   scope = "PER_PET", order = 5),
            // Per-visit items
            ChecklistItem(key = "secure",   text = "House / yard secure", scope = "PER_VISIT", order = 0),
            ChecklistItem(key = "locked",   text = "All doors locked",    scope = "PER_VISIT", order = 1),
            ChecklistItem(key = "alarm",    text = "Alarm system set",    scope = "PER_VISIT", order = 2),
            ChecklistItem(key = "mail",     text = "Mail / packages collected", scope = "PER_VISIT", order = 3),
            ChecklistItem(key = "plants",   text = "Plants watered",      scope = "PER_VISIT", order = 4),
            ChecklistItem(key = "trash",    text = "Trash taken out",     scope = "PER_VISIT", order = 5),
        ),
        // Mirrors the Android default (KinTaleTemplateEngine moodOptions) so a
        // pet-mood selection round-trips identically on either platform.
        moodOptions = listOf(
            MoodOption(key = "happy",     label = "Happy",     emoji = "😊", order = 0),
            MoodOption(key = "playful",   label = "Playful",   emoji = "🐾", order = 1),
            MoodOption(key = "calm",      label = "Calm",      emoji = "😌", order = 2),
            MoodOption(key = "cuddly",    label = "Cuddly",    emoji = "🤗", order = 3),
            MoodOption(key = "anxious",   label = "Anxious",   emoji = "😟", order = 4),
            MoodOption(key = "shy",       label = "Shy",       emoji = "🙈", order = 5),
            MoodOption(key = "energetic", label = "Energetic", emoji = "⚡",       order = 6),
            MoodOption(key = "sleepy",    label = "Sleepy",    emoji = "😴", order = 7),
        ),
    )
}

/** Composite key matching Android's `responseKey(fieldKey, kinId)` so reports round-trip. */
internal fun responseKey(fieldKey: String, kinId: String): String =
    if (kinId.isBlank()) fieldKey else "$kinId|$fieldKey"
