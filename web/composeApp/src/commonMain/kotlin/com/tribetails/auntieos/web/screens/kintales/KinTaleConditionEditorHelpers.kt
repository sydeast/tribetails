package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.ChecklistItem
import com.tribetails.auntieos.web.data.ConditionAttribute
import com.tribetails.auntieos.web.data.ConditionOp
import com.tribetails.auntieos.web.data.ConditionSource
import com.tribetails.auntieos.web.data.FieldCondition
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleConditionEngine
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.conditionAttributeCatalog
import com.tribetails.auntieos.web.data.conditionSourceOptions
import com.tribetails.auntieos.web.data.kinfolkAttributeCatalog

/**
 * Pure helpers behind the KinTale condition builder and the composer's checklist
 * filter. Extracted from the composables so both are unit-testable without a
 * Compose runtime ([KinTaleConditionEditorHelpersTest]); the composables stay thin
 * shells over these.
 *
 * Ported from the React admin, which is where templates are authored:
 * `lib/kinTaleTemplateEdit.ts` (attributeCatalogForSource, changeConditionSource,
 * opLabel, valuePlaceholder) and the "(unrecognised)" option behavior of
 * `screens/KinTaleTemplates.tsx#ConditionRow`. The tag picker has no React
 * counterpart (React types a tag name free-hand); it writes the same wire value,
 * a plain tag name String.
 */

// -----------------------------------------------------------------------------
// Source / op / attribute pickers
// -----------------------------------------------------------------------------

/**
 * The attribute catalog a source's key dropdown draws from: kin attributes for
 * KIN_ATTRIBUTE, household attributes for KINFOLK_ATTRIBUTE, and none for every
 * other source (which shows no attribute dropdown at all). KINFOLK_TAG is
 * deliberately absent: it matches a tag NAME, not a named field.
 */
internal fun attributeCatalogForSource(source: String): List<ConditionAttribute> = when (source) {
    ConditionSource.KIN_ATTRIBUTE.name     -> conditionAttributeCatalog
    ConditionSource.KINFOLK_ATTRIBUTE.name -> kinfolkAttributeCatalog
    else                                   -> emptyList()
}

/**
 * Switch a condition to a new source, keeping the rule valid by construction.
 * When the new source needs an attribute key and the current key is not in THAT
 * source's catalog (blank, or left over from the other attribute source), it is
 * re-seeded to the catalog's first entry, so the rule can never point at an
 * attribute the engine reads as blank. A source with no catalog leaves the key
 * untouched, matching React: the engine ignores it for those sources, and keeping
 * it lets the operator flip back without retyping.
 */
internal fun changeConditionSource(condition: FieldCondition, source: String): FieldCondition {
    val catalog = attributeCatalogForSource(source)
    if (catalog.isEmpty()) return condition.copy(source = source)
    val valid = catalog.any { it.key == condition.attributeKey }
    return condition.copy(source = source, attributeKey = if (valid) condition.attributeKey else catalog.first().key)
}

/**
 * The source names the "When" picker offers, in catalog order. A [current] value
 * this build does not model is PREPENDED and kept selected rather than snapping
 * the picker to KIN_SPECIES, which would silently rewrite a forward-compatible
 * rule authored by a newer app on the next save.
 */
internal fun conditionSourceChoices(current: String): List<String> {
    val known = conditionSourceOptions.map { it.source.name }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/** Editor copy for a source name; an unmodelled source is labelled, not hidden. */
internal fun conditionSourceLabel(source: String): String =
    conditionSourceOptions.firstOrNull { it.source.name == source }?.label
        ?: "$source (unrecognised)"

/** The op names the "Is" picker offers, with the same keep-the-unknown rule as [conditionSourceChoices]. */
internal fun conditionOpChoices(current: String): List<String> {
    val known = ConditionOp.entries.map { it.name }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/** Editor copy for an op name. */
internal fun conditionOpLabel(op: String): String = when (op) {
    ConditionOp.EQUALS.name     -> "is"
    ConditionOp.NOT_EQUALS.name -> "is not"
    ConditionOp.CONTAINS.name   -> "contains"
    ConditionOp.EXISTS.name     -> "is set"
    else                        -> "$op (unrecognised)"
}

/**
 * The attribute keys the "Attribute" picker offers for [source]. A stored key the
 * catalog does not know (a stray edit, or a newer app's field) is prepended so it
 * stays visible and selected instead of being silently swapped for another field.
 */
internal fun attributeKeyChoices(source: String, current: String): List<String> {
    val known = attributeCatalogForSource(source).map { it.key }
    return if (current.isNotBlank() && current !in known) listOf(current) + known else known
}

/**
 * Editor copy for an attribute key, looked up in the catalog that owns [source]. A
 * blank key (a legacy rule saved before the editor seeded one) reads as a prompt,
 * not as the first catalog entry: the rule genuinely has no field yet, and showing
 * one would misreport what is stored.
 */
internal fun attributeKeyLabel(source: String, key: String): String = when {
    key.isBlank() -> "Choose a field"
    else -> attributeCatalogForSource(source).firstOrNull { it.key == key }?.label
        ?: "$key (unrecognised)"
}

/** Placeholder for the free-text value input, tuned per source. */
internal fun conditionValuePlaceholder(source: String): String = when (source) {
    ConditionSource.KIN_SPECIES.name  -> "e.g. Cat"
    ConditionSource.SERVICE_TYPE.name -> "e.g. walk"
    ConditionSource.KINFOLK_TAG.name  -> "e.g. VIP"
    else                              -> "Value to match"
}

// -----------------------------------------------------------------------------
// Household tag picker
// -----------------------------------------------------------------------------

/** Whether the editor offers the household tag picker instead of the free-text value field. */
internal fun conditionUsesTagPicker(source: String): Boolean =
    source == ConditionSource.KINFOLK_TAG.name

/**
 * The tag names the KINFOLK_TAG picker offers: the household vocabulary in its
 * authored order, blanks dropped, de-duplicated case-INSENSITIVELY (the React tag
 * layer treats "vip" and "VIP" as one tag, so offering both would let the operator
 * pick a duplicate). Names keep the exact casing the vocabulary stores, because
 * that is what a profile assignment stores and what round-trips back to React.
 *
 * A [current] value that is not in the vocabulary is prepended and stays selected:
 * a tag can be authored on a condition before it is added to the vocabulary, or
 * removed from the vocabulary afterwards, and neither may silently rewrite the rule.
 */
internal fun tagPickerOptions(vocab: List<TagDef>, current: String): List<String> {
    val names = vocab.map { it.name }
        .filter { it.isNotBlank() }
        .distinctBy { it.trim().lowercase() }
    val hasCurrent = names.any { it.trim().equals(current.trim(), ignoreCase = true) }
    return if (current.isNotBlank() && !hasCurrent) listOf(current) + names else names
}

/** Editor copy for one tag option, flagging a name the operator's vocabulary does not carry. */
internal fun tagOptionLabel(name: String, vocab: List<TagDef>): String =
    if (vocab.any { it.name.trim().equals(name.trim(), ignoreCase = true) }) name
    else "$name (not in your tag list)"

// -----------------------------------------------------------------------------
// Visibility seams (the engine call sites)
// -----------------------------------------------------------------------------
//
// [kinfolk] has NO default value on either seam, on purpose. The engine fails
// OPEN on data it cannot resolve, so a call site that omits the household turns
// every KINFOLK_ATTRIBUTE / KINFOLK_TAG rule into "always show" without any error
// - the exact silent-wrong-answer bug I7 exists to close. Forcing the argument at
// every call site makes that omission a compile error rather than a live bug.

/** The per-pet checklist items [kin] actually qualifies for in this visit. */
internal fun visiblePerPetItems(
    items: List<ChecklistItem>,
    session: KinCareSession,
    kin: Kin,
    kinfolk: Kinfolk?,
): List<ChecklistItem> = items.filter {
    KinTaleConditionEngine.isChecklistItemVisible(it, session, listOf(kin), kinfolk)
}

/** The per-visit checklist items this visit qualifies for. */
internal fun visiblePerVisitItems(
    items: List<ChecklistItem>,
    session: KinCareSession,
    kinList: List<Kin>,
    kinfolk: Kinfolk?,
): List<ChecklistItem> = items.filter {
    KinTaleConditionEngine.isChecklistItemVisible(it, session, kinList, kinfolk)
}
