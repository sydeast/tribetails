package com.tribetails.auntieos.web.data

/**
 * Conditional-checklist engine for KinTale templates. A [ChecklistItem] with no
 * conditions is always shown; with conditions, it is only shown for kin / visits
 * that satisfy ALL of them (AND).
 *
 * This is a direct port of the Android `KinTaleTemplateEngine` so a template
 * authored on either platform produces the same kinfolk-facing report. The two
 * engines MUST stay in lock-step, and both stay in lock-step with the React admin
 * (auntieos-admin/src/lib/kinTale/engine.ts), which is where templates are now
 * authored; [KinTaleConditionEngineTest] pins the behavior case-for-case against
 * React's `engine.test.ts`.
 *
 * Unknown enum values (a newer app wrote a source/op this build doesn't know)
 * evaluate as "always visible" rather than throwing - a forward-compatible,
 * fail-open default that never hides an item because of a parsing gap.
 *
 * I7: two HOUSEHOLD sources sit on top of the three original ones, threaded
 * through as an optional [Kinfolk]:
 *   - KINFOLK_ATTRIBUTE reads one field of the household the visit belongs to
 *     (see [kinfolkAttributeCatalog]).
 *   - KINFOLK_TAG tests the household's `tags` list.
 * They were authored in the React admin before they existed here, so until now
 * they parsed as an unknown source and hit the fail-open branch: every household
 * condition silently evaluated true on web and desktop. The three original
 * sources evaluate identically whether or not a kinfolk is supplied.
 */
object KinTaleConditionEngine {

    /**
     * Whether a checklist item is visible at all in this session. [kinfolk] is
     * optional and only read by the KINFOLK_* sources, so call sites that only
     * build kin / service-type rules can keep omitting it.
     */
    fun isChecklistItemVisible(
        item: ChecklistItem,
        session: KinCareSession,
        kinList: List<Kin>,
        kinfolk: Kinfolk? = null,
    ): Boolean {
        if (item.conditions.isEmpty()) return true
        return if (item.scope.equals("PER_PET", ignoreCase = true)) {
            // PER_PET: visible if ANY kin in the visit matches.
            kinList.any { evaluateAll(item.conditions, session, it, kinfolk) }
        } else {
            // PER_VISIT: evaluated once against the first kin (service-type and
            // household rules need no kin at all).
            evaluateAll(item.conditions, session, kinList.firstOrNull(), kinfolk)
        }
    }

    /** For PER_PET items, the subset of kin the item actually applies to (order preserved). */
    fun applicableKinForChecklistItem(
        item: ChecklistItem,
        session: KinCareSession,
        kinList: List<Kin>,
        kinfolk: Kinfolk? = null,
    ): List<Kin> =
        if (item.conditions.isEmpty()) kinList
        else kinList.filter { evaluateAll(item.conditions, session, it, kinfolk) }

    private fun evaluateAll(
        conditions: List<FieldCondition>,
        session: KinCareSession,
        kin: Kin?,
        kinfolk: Kinfolk?,
    ): Boolean = conditions.all { evaluate(it, session, kin, kinfolk) }

    private fun evaluate(
        condition: FieldCondition,
        session: KinCareSession,
        kin: Kin?,
        kinfolk: Kinfolk?,
    ): Boolean {
        val source = runCatching { ConditionSource.valueOf(condition.source) }.getOrNull() ?: return true
        val op = runCatching { ConditionOp.valueOf(condition.op) }.getOrNull() ?: return true

        // KINFOLK_TAG compares against a LIST, not a single string, so it is
        // intercepted here rather than routed through [matches]. Sending it down
        // the string path would turn CONTAINS into a substring test and make the
        // tag "VI" match "VIP", which React never does.
        if (source == ConditionSource.KINFOLK_TAG) {
            return matchesTag(kinfolk?.tags.orEmpty(), condition.value, op)
        }

        val actual: String = when (source) {
            ConditionSource.SERVICE_TYPE      -> session.serviceType
            ConditionSource.KIN_SPECIES       -> kin?.species ?: ""
            ConditionSource.KIN_ATTRIBUTE     -> kin?.let { readAttribute(it, condition.attributeKey) } ?: ""
            ConditionSource.KINFOLK_ATTRIBUTE -> kinfolk?.let { readKinfolkAttribute(it, condition.attributeKey) } ?: ""
            ConditionSource.KINFOLK_TAG       -> "" // unreachable: handled above
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
     * Tag-list comparison for KINFOLK_TAG. EQUALS and CONTAINS mean the SAME
     * thing - "a tag equal to [expected] is present" - because a tag is a whole
     * label, not a body of text; there is no substring matching. EXISTS means the
     * household carries any non-blank tag at all, and ignores [expected].
     * Comparison is trimmed and case-insensitive on both sides, matching the
     * React tag layer (which is case-insensitive everywhere).
     */
    private fun matchesTag(tags: List<String>, expected: String, op: ConditionOp): Boolean {
        val e = expected.trim()
        val present = tags.any { it.trim().equals(e, ignoreCase = true) }
        return when (op) {
            ConditionOp.EXISTS     -> tags.any { it.isNotBlank() }
            ConditionOp.NOT_EQUALS -> !present
            ConditionOp.EQUALS     -> present
            ConditionOp.CONTAINS   -> present
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

    /**
     * Maps a catalogued HOUSEHOLD attribute key to its value on the kinfolk. MUST
     * cover every key in [kinfolkAttributeCatalog] (guarded by the engine test).
     * An uncatalogued key reads as blank on purpose: a household field the editor
     * does not offer must never leak into a condition.
     */
    private fun readKinfolkAttribute(kinfolk: Kinfolk, key: String): String = when (key) {
        "serviceAddress"        -> kinfolk.serviceAddress
        "gateCode"              -> kinfolk.gateCode
        "parkingInstructions"   -> kinfolk.parkingInstructions
        "entryNotes"            -> kinfolk.entryNotes
        // #829: the first Emergency Contact (array, flat triple as fallback). The
        // keys are unchanged so saved conditions keep working.
        "emergencyContactName"  -> emergencyContactsOf(kinfolk).firstOrNull()?.name.orEmpty()
        "emergencyContactPhone" -> emergencyContactsOf(kinfolk).firstOrNull()?.phone.orEmpty()
        "vetClinicName"         -> kinfolk.vetClinicName
        else                    -> ""
    }
}

/** An attribute an operator can build a KIN_ATTRIBUTE / KINFOLK_ATTRIBUTE condition on. */
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
 * I7: the canonical list of KINFOLK (household) attributes the editor offers for a
 * KINFOLK_ATTRIBUTE condition. Every key must be readable by
 * [KinTaleConditionEngine] (asserted in the engine test). Keys and labels are
 * byte-identical to the React `kinfolkAttributeCatalog`; only fields the engine
 * can actually resolve are listed, so household fields like wifiPassword are
 * deliberately absent.
 */
val kinfolkAttributeCatalog: List<ConditionAttribute> = listOf(
    ConditionAttribute("serviceAddress",        "Service address"),
    ConditionAttribute("gateCode",              "Gate code"),
    ConditionAttribute("parkingInstructions",   "Parking instructions"),
    ConditionAttribute("entryNotes",            "Entry notes"),
    ConditionAttribute("emergencyContactName",  "Emergency contact"),
    ConditionAttribute("emergencyContactPhone", "Emergency contact phone"),
    ConditionAttribute("vetClinicName",         "Vet on file"),
)

/** One selectable condition source, for the editor's source picker. */
data class ConditionSourceOption(val source: ConditionSource, val label: String)

/**
 * The sources the condition editor offers, in the same order React lists them.
 * These labels are EDITOR COPY, not wire format (the wire format is
 * [ConditionSource.name]), so the three original entries keep the wording the
 * Compose editor already shipped rather than adopting React's phrasing.
 */
val conditionSourceOptions: List<ConditionSourceOption> = listOf(
    ConditionSourceOption(ConditionSource.KIN_SPECIES,       "Pet species"),
    ConditionSourceOption(ConditionSource.KIN_ATTRIBUTE,     "Pet attribute"),
    ConditionSourceOption(ConditionSource.SERVICE_TYPE,      "Service type"),
    ConditionSourceOption(ConditionSource.KINFOLK_ATTRIBUTE, "Household attribute"),
    ConditionSourceOption(ConditionSource.KINFOLK_TAG,       "Household tag"),
)

/**
 * Editor helper: whether this condition's `source` picks an attribute key (and so
 * the editor shows the attribute dropdown). True for the two attribute sources,
 * KIN_ATTRIBUTE and KINFOLK_ATTRIBUTE. KINFOLK_TAG does NOT: it matches against
 * the household's tag list, not a named field. Unknown sources do not either,
 * matching the fail-open engine default.
 */
fun conditionUsesAttributeKey(sourceName: String): Boolean =
    sourceName == ConditionSource.KIN_ATTRIBUTE.name ||
        sourceName == ConditionSource.KINFOLK_ATTRIBUTE.name

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
        val label = attributeLabel(conditionAttributeCatalog, c.attributeKey)
        return when (op) {
            ConditionOp.EXISTS     -> "Only show when the pet has $label"
            ConditionOp.EQUALS     -> "Only show when the pet's $label is $value"
            ConditionOp.NOT_EQUALS -> "Only show when the pet's $label is not $value"
            ConditionOp.CONTAINS   -> "Only show when the pet's $label contains $value"
        }
    }

    if (source == ConditionSource.KINFOLK_ATTRIBUTE) {
        val label = attributeLabel(kinfolkAttributeCatalog, c.attributeKey)
        return when (op) {
            // "is set", not the pet branch's "has": a household field is a single
            // value the operator either filled in or did not.
            ConditionOp.EXISTS     -> "Only show when the household's $label is set"
            ConditionOp.EQUALS     -> "Only show when the household's $label is $value"
            ConditionOp.NOT_EQUALS -> "Only show when the household's $label is not $value"
            ConditionOp.CONTAINS   -> "Only show when the household's $label contains $value"
        }
    }

    if (source == ConditionSource.KINFOLK_TAG) {
        return when (op) {
            ConditionOp.EXISTS     -> "Only show when the household has any tags"
            ConditionOp.NOT_EQUALS -> "Only show when the household is not tagged $value"
            // EQUALS and CONTAINS are the same test on a tag list, so they read the same.
            ConditionOp.EQUALS     -> "Only show when the household is tagged $value"
            ConditionOp.CONTAINS   -> "Only show when the household is tagged $value"
        }
    }

    // KIN_SPECIES / SERVICE_TYPE generic branch.
    val subject = if (source == ConditionSource.KIN_SPECIES) "the pet's species" else "the service type"
    return when (op) {
        ConditionOp.EQUALS     -> "Only show when $subject is $value"
        ConditionOp.NOT_EQUALS -> "Only show when $subject is not $value"
        ConditionOp.CONTAINS   -> "Only show when $subject contains $value"
        ConditionOp.EXISTS     -> "Only show when $subject is set"
    }
}

/**
 * The editor-facing label for an attribute key: the catalogued label when the key
 * is known, otherwise the raw key (so an unknown key stays diagnosable rather
 * than rendering as nothing), or "an attribute" when no key is set at all.
 */
private fun attributeLabel(catalog: List<ConditionAttribute>, key: String): String =
    catalog.firstOrNull { it.key == key }?.label ?: key.ifBlank { "an attribute" }
