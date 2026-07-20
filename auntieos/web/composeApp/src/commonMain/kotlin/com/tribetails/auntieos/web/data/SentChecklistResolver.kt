package com.tribetails.auntieos.web.data

/** One resolved, checked checklist item ready to render on the sent report. */
data class SentChecklistItem(val key: String, val label: String)

/** A kin's resolved checked items on the sent report. */
data class SentKinChecklist(val kinId: String, val items: List<SentChecklistItem>)

/** The sent report's checklist, split per-kin and per-visit. */
data class SentChecklist(
    val perKin: List<SentKinChecklist>,
    val perVisit: List<SentChecklistItem>,
)

/**
 * Resolves the checklist that renders on a SENT KinTale report, from the REAL
 * template the visit used (not the built-in default). Rules:
 *  - only checked responses (boolValue == true) render (Precise semantics),
 *  - labels + ordering come from the real template (custom keys + renamed items
 *    show correctly; a key the template no longer has is dropped, since it can't
 *    be labeled - parity with the Android report, which iterates template items),
 *  - conditions are honored (KinTaleConditionEngine): a checked item whose
 *    condition the kin / visit no longer satisfies (e.g. a condition added after
 *    the visit was checked) does NOT render. When the kin can't be resolved we
 *    can't evaluate KIN conditions, so the item is kept rather than dropped.
 *
 * [kinfolk] is the household the visit belongs to, and it is only read by the
 * KINFOLK_* condition sources. Passing it is not optional in practice: a null
 * household is not neutral, because KINFOLK_ATTRIBUTE then reads "" and
 * KINFOLK_TAG reads an empty list, so an EQUALS or CONTAINS rule never matches
 * and the checked item is silently HIDDEN from the sent report. It stays
 * nullable only so the resolver still works for reports whose household cannot
 * be resolved, and for the callers that build no household rules.
 *
 * Pure + unit-tested ([SentChecklistResolverTest]); the composable just renders it.
 */
fun resolveSentChecklist(
    template: KinTaleTemplate,
    report: KinCareReport,
    kinById: Map<String, Kin>,
    kinfolk: Kinfolk? = null,
): SentChecklist {
    val itemByKey = template.checklistItems.associateBy { it.key }
    val orderByKey = template.checklistItems.withIndex().associate { (i, it) -> it.key to i }
    val session = KinCareSession(serviceType = report.serviceType)
    val checked = report.fieldResponses.values.filter { it.boolValue == true }

    fun ordered(items: List<ChecklistItem>): List<SentChecklistItem> =
        items.distinctBy { it.key }
            .sortedBy { orderByKey[it.key] ?: Int.MAX_VALUE }
            .map { SentChecklistItem(it.key, it.text.ifBlank { it.key }) }

    val perKin = checked
        .filter { it.kinId.isNotBlank() && itemByKey[it.fieldKey]?.scope.equalsScope("PER_PET") }
        .groupBy { it.kinId }
        .map { (kinId, responses) ->
            val kin = kinById[kinId]
            val items = responses.mapNotNull { itemByKey[it.fieldKey] }
                .filter { item ->
                    // Honor conditions when we can resolve the kin; otherwise keep
                    // the checked item (never hide on missing data).
                    kin == null || KinTaleConditionEngine.isChecklistItemVisible(item, session, listOf(kin), kinfolk)
                }
            SentKinChecklist(kinId, ordered(items))
        }
        .filter { it.items.isNotEmpty() }

    val visitKin = report.kinIds.mapNotNull { kinById[it] }.ifEmpty { kinById.values.toList() }
    val perVisitItems = checked
        .mapNotNull { itemByKey[it.fieldKey] }
        .filter { it.scope.equalsScope("PER_VISIT") }
        .filter { KinTaleConditionEngine.isChecklistItemVisible(it, session, visitKin, kinfolk) }
    val perVisit = ordered(perVisitItems)

    return SentChecklist(perKin, perVisit)
}

private fun String?.equalsScope(scope: String): Boolean = this?.equals(scope, ignoreCase = true) == true
