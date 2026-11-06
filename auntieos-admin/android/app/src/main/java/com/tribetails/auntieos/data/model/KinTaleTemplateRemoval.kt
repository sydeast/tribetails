package com.tribetails.auntieos.data.model
/**
 * #1591: the pure half of taking a KinTale template out of service. The web
 * admin carries the same module at `auntieos-admin/src/api/kinTaleTemplateRemoval.ts`
 * and the sentences below match it word for word.
 *
 * WHAT IS DECIDED AND WHAT IS NOT. The operator has not ruled on what "remove"
 * means: hard delete behind a usage warning, archive, or both. Built here and
 * shared by every option: the server's usage answer ([KinTaleTemplateUsage]),
 * the sentences that name what breaks ([kinTaleTemplateRemovalImpact]) and the
 * mode the one entry point takes ([KinTaleTemplateRemoval]). The entry point is
 * `AuntieRepository.removeKinTaleTemplate`; no screen shows a Delete control
 * yet, because which button it is, and what it does, is the ruling.
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
    /** Other active templates a service type could fall back to. */
    val otherActiveTemplateCount: Int,
)
/** Only DELETE exists. ARCHIVE joins when the operator rules it in. */
enum class KinTaleTemplateRemoval { DELETE }
/**
 * What stops working if the template doc is gone, one line each. Empty when
 * nothing depends on it. These are the consequences of DELETE: the household
 * feed drops the checklist of a KinTale whose template is missing.
 */
fun kinTaleTemplateRemovalImpact(usage: KinTaleTemplateUsage): List<String> {
    val lines = mutableListOf<String>()
    val n = usage.kintaleCount
    if (n > 0) {
        lines += "$n KinTale${if (n == 1) " was" else "s were"} written from it. " +
            "${if (n == 1) "Its" else "Their"} ticked checklist items stop showing to the household, " +
            "because the household feed reads the labels from the template."
    }
    if (usage.isDefault) {
        lines += if (usage.otherActiveTemplateCount > 0) {
            "It is the default template. Visits with no matching service type lose their default until another template is made the default."
        } else {
            "It is the default template and the only active one. Visits fall back to the built-in Standard Visit."
        }
    }
    return lines
}
/** Decodes the `getKinTaleTemplateUsage` callable payload. Missing fields read as "nothing uses it". */
fun parseKinTaleTemplateUsage(raw: Map<String, Any?>): KinTaleTemplateUsage = KinTaleTemplateUsage(
    templateId = raw["templateId"] as? String ?: "",
    exists = raw["exists"] as? Boolean ?: false,
    name = raw["name"] as? String ?: "",
    isDefault = raw["isDefault"] as? Boolean ?: false,
    isActive = raw["isActive"] as? Boolean ?: true,
    kintaleCount = (raw["kintaleCount"] as? Number)?.toInt() ?: 0,
    otherActiveTemplateCount = (raw["otherActiveTemplateCount"] as? Number)?.toInt() ?: 0,
)
