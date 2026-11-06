package com.tribetails.auntieos.web.data
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
/**
 * #1591: the pure half of taking a KinTale template out of service. Web
 * (`api/kinTaleTemplateRemoval.ts`) and Android (`KinTaleTemplateRemoval.kt`)
 * carry the same module; the sentences below match them word for word.
 *
 * The operator has not ruled on what "remove" means (hard delete behind a usage
 * warning, archive, or both). Built here and shared by every option: the
 * server's usage answer, the sentences that name what breaks, and the mode the
 * one entry point ([FirestoreClient.removeKinTaleTemplate]) takes. No screen
 * shows a Delete control yet; which button it is, and what it does, is the ruling.
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
private val usageJson = Json { ignoreUnknownKeys = true; isLenient = true }
/** Decodes the `getKinTaleTemplateUsage` callable payload. Missing fields read as "nothing uses it". */
fun decodeKinTaleTemplateUsage(body: String): KinTaleTemplateUsage {
    val o = usageJson.parseToJsonElement(body).jsonObject
    return KinTaleTemplateUsage(
        templateId = o["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        exists = o["exists"]?.jsonPrimitive?.booleanOrNull ?: false,
        name = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        isDefault = o["isDefault"]?.jsonPrimitive?.booleanOrNull ?: false,
        isActive = o["isActive"]?.jsonPrimitive?.booleanOrNull ?: true,
        kintaleCount = o["kintaleCount"]?.jsonPrimitive?.intOrNull ?: 0,
        otherActiveTemplateCount = o["otherActiveTemplateCount"]?.jsonPrimitive?.intOrNull ?: 0,
    )
}
