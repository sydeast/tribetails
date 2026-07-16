package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Admin-side wrapper for email-template + binding callables (saveTemplate,
 * assignTemplate, listTemplates, listTemplateBindings).
 *
 * Mirrors the Android `TemplateRepository`. All four callables are
 * admin-claim-gated server-side. wasmJs hits the real callables via the
 * `window.__fb.callFunction` JS bridge; jvm returns `WriteResult.Err` until
 * desktop wiring is added.
 */
class TemplateService {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    data class EmailTemplate(
        val templateId: String,
        val subject: String,
        val body: String,
        val html: String?,
        val title: String,
        val description: String?,
        val tags: List<String>,
        val category: String?,
    )

    data class TemplateBinding(
        val catalogKey: String,
        val templateId: String,
        val audience: String?,
        val triggerKey: String?,
        val active: Boolean,
    )

    suspend fun listTemplates(): WriteResult<List<EmailTemplate>> {
        val r = platformInvokeCallable("listTemplates", "{}")
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatching {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    val arr = obj["templates"] as? JsonArray ?: JsonArray(emptyList())
                    val list = arr.map { decodeTemplate(it.jsonObject) }
                    WriteResult.Ok(list)
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    /**
     * Server-deduped category list (hybrid: managed `template_categories` ∪ distinct
     * categories already on templates). Replaces each screen re-deriving its own
     * client-side dedup. Returns the names sorted, case-insensitively unique.
     */
    suspend fun listCategories(): WriteResult<List<String>> {
        val r = platformInvokeCallable("listCategories", "{}")
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatching {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    val arr = obj["categories"] as? JsonArray ?: JsonArray(emptyList())
                    WriteResult.Ok(arr.mapNotNull { it.jsonPrimitive.contentOrNull })
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    suspend fun listBindings(): WriteResult<List<TemplateBinding>> {
        val r = platformInvokeCallable("listTemplateBindings", "{}")
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatching {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    val arr = obj["bindings"] as? JsonArray ?: JsonArray(emptyList())
                    val list = arr.map { decodeBinding(it.jsonObject) }
                    WriteResult.Ok(list)
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    /**
     * Stage 2 tail: the distinct set of template catalog keys currently in use,
     * via the read-only listCatalogKeys callable. Optional case-insensitive
     * substring filter. Used by the Template Assignment screen to flag catalog
     * keys that have no binding yet.
     */
    suspend fun listCatalogKeys(filter: String? = null): WriteResult<List<String>> {
        val payload = buildJsonObject {
            if (!filter.isNullOrBlank()) put("filter", JsonPrimitive(filter))
        }
        val r = platformInvokeCallable("listCatalogKeys", json.encodeToString(JsonObject.serializer(), payload))
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatching {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    val arr = obj["keys"] as? JsonArray ?: JsonArray(emptyList())
                    WriteResult.Ok(arr.mapNotNull { it.jsonPrimitive.contentOrNull })
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    suspend fun saveTemplate(template: EmailTemplate): WriteResult<String> {
        val payload = buildJsonObject {
            put("templateId", JsonPrimitive(template.templateId))
            put("subject", JsonPrimitive(template.subject))
            put("body", JsonPrimitive(template.body))
            template.html?.let { put("html", JsonPrimitive(it)) }
            put("title", JsonPrimitive(template.title))
            template.description?.let { put("description", JsonPrimitive(it)) }
            put("tags", JsonArray(template.tags.map { JsonPrimitive(it) }))
            template.category?.let { put("category", JsonPrimitive(it)) }
        }
        val r = platformInvokeCallable("saveTemplate", json.encodeToString(JsonObject.serializer(), payload))
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatching {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    WriteResult.Ok(obj["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty())
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    suspend fun assignTemplate(
        catalogKey: String,
        templateId: String,
        audience: String? = null,
        triggerKey: String? = null,
        active: Boolean = true,
    ): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("catalogKey", JsonPrimitive(catalogKey))
            put("templateId", JsonPrimitive(templateId))
            audience?.let { put("audience", JsonPrimitive(it)) }
            triggerKey?.let { put("triggerKey", JsonPrimitive(it)) }
            put("active", JsonPrimitive(active))
        }
        val r = platformInvokeCallable("assignTemplate", json.encodeToString(JsonObject.serializer(), payload))
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    private fun decodeTemplate(o: JsonObject): EmailTemplate = EmailTemplate(
        templateId = o["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        subject = o["subject"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        body = o["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        html = o["html"]?.jsonPrimitive?.contentOrNull,
        title = o["title"]?.jsonPrimitive?.contentOrNull
            ?: o["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        description = o["description"]?.jsonPrimitive?.contentOrNull,
        tags = (o["tags"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
        category = o["category"]?.jsonPrimitive?.contentOrNull,
    )

    private fun decodeBinding(o: JsonObject): TemplateBinding = TemplateBinding(
        catalogKey = o["catalogKey"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        templateId = o["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        audience = o["audience"]?.jsonPrimitive?.contentOrNull,
        triggerKey = o["triggerKey"]?.jsonPrimitive?.contentOrNull,
        active = o["active"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}
