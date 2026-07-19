package com.tribetails.auntieos.data.model

import androidx.annotation.Keep

import com.google.firebase.firestore.DocumentId

// A KinTaleTemplate defines the shape of a visit recap. Different service types
// (dog walking, overnight stay, cat sit, daycare drop-off, ...) use different
// templates. Each template has a set of typed Display Sections (Photo Showcase,
// Checklist, Pet Mood, Visit Notes, Next Appointment, Review Booster) that can
// be toggled on/off. Each section has its own configuration.
//
// Conditional fields are supported on ChecklistItems (e.g. "Litter box scooped"
// only shows for cats; "Meds given" only shows for kin with medication notes)
// via the rules engine. The simple editor doesn't yet expose the condition
// builder - that's a follow-up.

@Keep
data class KinTaleTemplate(
    @DocumentId val id: String = "",
    var name: String = "",                     // e.g. "Default Pet Care Report"
    var description: String = "",
    var defaultEmailMessage: String = "I had a wonderful time caring for your furry friends! Here's how they did today.",
    var serviceTypeKeys: List<String> = emptyList(),
    var isActive: Boolean = true,
    var isDefault: Boolean = false,            // exactly one default template per workspace

    // Typed display section toggles
    var photoShowcaseEnabled: Boolean = true,
    var checklistEnabled: Boolean = true,
    var petMoodEnabled: Boolean = true,
    var visitNotesEnabled: Boolean = true,
    var nextAppointmentEnabled: Boolean = true,
    var reviewBoosterEnabled: Boolean = false,

    // Sub-configurations
    var checklistItems: List<ChecklistItem> = emptyList(),
    var moodOptions: List<MoodOption> = emptyList(),
    var reviewBoosterConfig: ReviewBoosterConfig = ReviewBoosterConfig(),

    var createdAt: String = "",
    var updatedAt: String = ""
)

// ----- Checklist -----

@Keep
data class ChecklistItem(
    var key: String = "",                      // stable id for fieldResponses
    var text: String = "",                     // user-visible label ("Peed", "Fed")
    var scope: String = ChecklistScope.PER_PET.name,
    var showWhenUnchecked: Boolean = false,    // include unchecked items in the kinfolk-facing report
    var order: Int = 0,
    var conditions: List<FieldCondition> = emptyList()  // power feature; editor TBD
)

enum class ChecklistScope { PER_PET, PER_VISIT }

/** Run-4 #7b: one item in the shared bank of common KinTale checklist tasks. */
@Keep
data class ChecklistBankItem(
    val id: String = "",
    val text: String = "",
    val scope: String = "PER_PET",             // matches ChecklistScope.name
)

// ----- Pet mood -----

@Keep
data class MoodOption(
    var key: String = "",
    var label: String = "",                    // "Happy", "Anxious", "Cuddly"
    var emoji: String = "",                    // 😊
    var order: Int = 0
)

// ----- Review booster -----

@Keep
data class ReviewBoosterConfig(
    var googleEnabled: Boolean = false,
    var yelpEnabled: Boolean = false,
    var facebookEnabled: Boolean = false,
    var googleUrl: String = "",
    var yelpUrl: String = "",
    var facebookUrl: String = ""
)

// ----- Conditional rules -----

@Keep
data class FieldCondition(
    var source: String = ConditionSource.KIN_SPECIES.name,
    var op: String = ConditionOp.EQUALS.name,
    var value: String = "",
    var attributeKey: String = ""
)

enum class ConditionSource {
    KIN_SPECIES,
    KIN_ATTRIBUTE,
    SERVICE_TYPE
}

enum class ConditionOp {
    EQUALS,
    NOT_EQUALS,
    CONTAINS,
    EXISTS
}

// ----- Field response stored on the KinCareReport -----

@Keep
data class FieldResponse(
    var fieldKey: String = "",
    var kinId: String = "",
    var sectionKey: String = "",
    var boolValue: Boolean? = null,
    var intValue: Int? = null,
    var stringValue: String = "",
    var mediaIds: List<String> = emptyList()
)
