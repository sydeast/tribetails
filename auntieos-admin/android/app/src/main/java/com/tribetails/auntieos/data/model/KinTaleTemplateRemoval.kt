package com.tribetails.auntieos.data.model

/**
 * #1591: the pure half of taking a KinTale template out of service and putting
 * it back. The web admin carries the same module at
 * `auntieos-admin/src/api/kinTaleTemplateRemoval.ts` and the sentences below
 * match it word for word.
 *
 * OPERATOR RULING, 2026-11-05 docket: "both". Remove moves a template to an
 * archive ([KinTaleTemplateRemoval.ARCHIVE]): the doc stays, so it is
 * restorable, but it is hidden from the template list and never picked for a
 * new KinTale. Deleting for good ([KinTaleTemplateRemoval.DELETE]) happens only
 * from inside the archive, behind the warning that says how many KinTales used
 * it; `firestore.rules` refuses a delete of a template that is not archived.
 * Removal stays owner-only. The entry point is `AuntieRepository.removeKinTaleTemplate`.
 */
data class KinTaleTemplateUsage(
    val templateId: String,
    /** False when the template is already gone (a stale id). */
    val exists: Boolean,
    val name: String,
    val isDefault: Boolean,
    val isActive: Boolean,
    /** KinTales, sent or draft, written from this template. */
    val kintaleCount: Int,
    /** Other live templates a service type could fall back to. */
    val otherActiveTemplateCount: Int,
    /** True when the template sits in the archive. */
    val archived: Boolean = false,
)

enum class KinTaleTemplateRemoval { ARCHIVE, RESTORE, DELETE }

/**
 * What deleting for good means for the KinTales written from it, one line each,
 * for the delete-for-good confirm, under the count [kinTaleTemplateDeleteHeadline]
 * leads with. Empty when nothing used it.
 *
 * #2058 (operator ruling 2026-11-12, stamp at send): a sent KinTale keeps its own
 * copy of the care tasks, so deleting the template takes nothing from a household.
 * The line used to say the ticked items stop showing, which was true then; it also
 * repeated the count and explained how the feed works. Same words as the web
 * admin's `removalImpact`.
 */
fun kinTaleTemplateRemovalImpact(usage: KinTaleTemplateUsage): List<String> =
    if (usage.kintaleCount <= 0) emptyList() else listOf(SENT_KINTALES_KEEP_TASKS)
/** #2058: the delete confirm's promise about KinTales already sent. */
const val SENT_KINTALES_KEEP_TASKS = "KinTales already sent keep their care tasks."
/** The line the delete-for-good confirm leads with: how many KinTales used it. */
fun kinTaleTemplateDeleteHeadline(usage: KinTaleTemplateUsage): String {
    val n = usage.kintaleCount
    return if (n == 0) {
        "No KinTale was written from this template."
    } else {
        "$n KinTale${if (n == 1) " was" else "s were"} written from this template."
    }
}

/** What moving a template to the archive does, for the Remove confirm. Nothing breaks. */
fun kinTaleTemplateArchiveImpact(isDefault: Boolean): List<String> = buildList {
    add("New KinTales stop using it. KinTales already written from it keep it.")
    add("You can restore it from the archive, or delete it for good there.")
    if (isDefault) {
        add(
            "It is the default template, so visits with no matching service type use the built-in " +
                "Standard Visit until it is restored or another template is made the default.",
        )
    }
}

/**
 * Whether restoring [template] must drop its default flag: another live template
 * became the default while it sat in the archive, and there is only ever one.
 */
fun kinTaleTemplateRestoreClearsDefault(template: KinTaleTemplate, all: List<KinTaleTemplate>): Boolean =
    template.isDefault && all.any { it.id != template.id && it.isDefault && !it.archived }

/** Decodes the `getKinTaleTemplateUsage` callable payload. Missing fields read as "nothing uses it". */
fun parseKinTaleTemplateUsage(raw: Map<String, Any?>): KinTaleTemplateUsage = KinTaleTemplateUsage(
    templateId = raw["templateId"] as? String ?: "",
    exists = raw["exists"] as? Boolean ?: false,
    name = raw["name"] as? String ?: "",
    isDefault = raw["isDefault"] as? Boolean ?: false,
    isActive = raw["isActive"] as? Boolean ?: true,
    kintaleCount = (raw["kintaleCount"] as? Number)?.toInt() ?: 0,
    otherActiveTemplateCount = (raw["otherActiveTemplateCount"] as? Number)?.toInt() ?: 0,
    archived = raw["archived"] as? Boolean ?: false,
)
