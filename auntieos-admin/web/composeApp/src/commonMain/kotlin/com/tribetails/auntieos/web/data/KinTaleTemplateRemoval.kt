package com.tribetails.auntieos.web.data
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #1591: the pure half of taking a KinTale template out of service and putting
 * it back. Web (`api/kinTaleTemplateRemoval.ts`) and Android
 * (`KinTaleTemplateRemoval.kt`) carry the same module; the sentences below
 * match them word for word.
 *
 * OPERATOR RULING, 2026-11-05 docket: "both". Remove moves a template to an
 * archive (restorable, hidden from the list and from new KinTales); deleting
 * for good happens only from inside the archive, with the warning that says
 * how many KinTales used it. Removal stays owner-only. The entry point is
 * [FirestoreClient.removeKinTaleTemplate].
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
    template.isDefault && all.any { it._id != template._id && it.isDefault && !it.archived }

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
        archived = o["archived"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}
