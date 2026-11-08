package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.observability.runCatchingCancellable
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
 * admin-claim-gated server-side. Both platforms hit the REAL callables through
 * `platformInvokeCallable`: wasmJs via the `window.__fb.callFunction` JS bridge,
 * jvm/desktop via `JvmFirestoreRest.callable` (a Bearer-idToken POST to
 * us-central1 cloudfunctions). The old "jvm returns Err until wired" note was
 * stale, that desktop wiring exists.
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
        /** #953 PR 1: null until listTemplates sends it (a later PR). Any
         * non-null format (such as "visual") is read-only on this device. */
        val format: String? = null,
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
                runCatchingCancellable {
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
                runCatchingCancellable {
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
                runCatchingCancellable {
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
                runCatchingCancellable {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    val arr = obj["keys"] as? JsonArray ?: JsonArray(emptyList())
                    WriteResult.Ok(arr.mapNotNull { it.jsonPrimitive.contentOrNull })
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
        }
    }

    /**
     * #1586: the routing ROWS behind listCatalogKeys, not just the key names, so
     * the screen can say which keys really fail on send. One call: the `keys`
     * array the older [listCatalogKeys] reads is exactly `rows.map { it.key }`.
     */
    suspend fun listCatalogKeyRows(): WriteResult<List<CatalogKeyRow>> {
        val r = platformInvokeCallable("listCatalogKeys", "{}")
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatchingCancellable {
                WriteResult.Ok(decodeCatalogKeyRows(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
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
                runCatchingCancellable {
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

    /**
     * AO-56: remove the binding for [catalogKey] via the unassignTemplate callable
     * (deletes notificationTemplateBindings/{catalogKey}). The inverse of
     * [assignTemplate], and the half that used to be missing: without it a bound
     * template could never be deleted (deleteTemplate refuses while a binding
     * points at it). Returns the server's `removed` flag (false = the key was
     * already unbound; the call is idempotent, never a not-found error).
     */
    suspend fun unassignTemplate(catalogKey: String): WriteResult<Boolean> {
        val payload = buildJsonObject { put("catalogKey", JsonPrimitive(catalogKey)) }
        val r = platformInvokeCallable("unassignTemplate", json.encodeToString(JsonObject.serializer(), payload))
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> {
                runCatchingCancellable {
                    val obj = json.parseToJsonElement(r.value).jsonObject
                    WriteResult.Ok(obj["removed"]?.jsonPrimitive?.booleanOrNull ?: false)
                }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
            }
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
        format = o["format"]?.jsonPrimitive?.contentOrNull,
    )

    private fun decodeBinding(o: JsonObject): TemplateBinding = TemplateBinding(
        catalogKey = o["catalogKey"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        templateId = o["templateId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        audience = o["audience"]?.jsonPrimitive?.contentOrNull,
        triggerKey = o["triggerKey"]?.jsonPrimitive?.contentOrNull,
        active = isBindingActive(o["active"]?.jsonPrimitive?.booleanOrNull),
    )

    companion object {
        /**
         * #965: a `listTemplateBindings` row with no `active` field is live,
         * matching `resolveTemplateId` on the server (`active !== false`). The
         * bug this fixes was decoding a missing field here as `false`, so a
         * binding the dispatcher was actually sending through showed as
         * paused. Mirrors Android's `TemplateRepository.isBindingActive`.
         */
        fun isBindingActive(active: Boolean?): Boolean = active != false
    }
}

/**
 * One row of the listCatalogKeys routing table (#1586). Mirrors the Android
 * `TemplateRepository.CatalogKey` and the web `CatalogKeyRow`.
 */
data class CatalogKeyRow(
    val key: String,
    /** 'catalog', 'direct-send' or 'legacy'. */
    val source: String,
    val defaultTemplateId: String,
    val hasDefaultTemplate: Boolean,
    val bound: Boolean,
    val resolvedTemplateId: String,
    /**
     * What a send does when the resolved template document is missing: "fails",
     * "repoCopy", "generic" or "unused". A server from before #1586 omits it,
     * read as "fails".
     */
    val whenTemplateMissing: String = "fails",
    /** Whether the repo carries a copy Template Import can load. */
    val inRepoCorpus: Boolean = false,
    /** The catalog's name for the key ("New invoice"), what the operator reads (#1592). */
    val label: String = "",
)

private val MISSING_TEMPLATE_EFFECTS = setOf("fails", "repoCopy", "generic", "unused")

private val rowJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Pure decode of the listCatalogKeys body `{rows:[...]}`. Throws on malformed JSON. */
internal fun decodeCatalogKeyRows(body: String): List<CatalogKeyRow> {
    val obj = rowJson.parseToJsonElement(body).jsonObject
    val arr = obj["rows"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        fun bool(k: String) = (o[k] as? JsonPrimitive)?.booleanOrNull
        val key = str("key") ?: return@mapNotNull null
        val default = str("defaultTemplateId") ?: key
        CatalogKeyRow(
            key = key,
            source = str("source") ?: "catalog",
            defaultTemplateId = default,
            hasDefaultTemplate = bool("hasDefaultTemplate") ?: false,
            bound = bool("bound") ?: false,
            resolvedTemplateId = str("resolvedTemplateId") ?: default,
            whenTemplateMissing = str("whenTemplateMissing")?.takeIf { it in MISSING_TEMPLATE_EFFECTS } ?: "fails",
            inRepoCorpus = bool("inRepoCorpus") ?: false,
            label = str("label").orEmpty(),
        )
    }
}

/**
 * Whether the template this row resolves to is missing. A name-matched default
 * uses the server's check; an override is checked against the loaded bank, and
 * only once the bank loaded, so an unavailable listTemplates paints nothing.
 */
internal fun resolvedTemplateMissing(row: CatalogKeyRow, bankIds: Set<String>, bankLoaded: Boolean): Boolean =
    if (row.resolvedTemplateId != row.defaultTemplateId) bankLoaded && row.resolvedTemplateId !in bankIds
    else !row.hasDefaultTemplate
/** #1586: keys whose next send FAILS because the template is missing. */
internal fun keysFailingOnSend(rows: List<CatalogKeyRow>, bankIds: Set<String>, bankLoaded: Boolean): List<String> =
    rows.filter { it.whenTemplateMissing == "fails" && resolvedTemplateMissing(it, bankIds, bankLoaded) }.map { it.key }

/** #1586: the failing keys the repo has a copy of, so Template Import can fix them. */
internal fun failingKeysWithRepoCopy(rows: List<CatalogKeyRow>, bankIds: Set<String>, bankLoaded: Boolean): List<String> {
    val failing = keysFailingOnSend(rows, bankIds, bankLoaded).toSet()
    return rows.filter { it.key in failing && it.inRepoCorpus }.map { it.key }
}
/** #1586: keys missing from the bank that still go out and Template Import can load. */
internal fun keysAwaitingImport(rows: List<CatalogKeyRow>, bankIds: Set<String>, bankLoaded: Boolean): List<String> =
    rows.filter {
        it.inRepoCorpus &&
            (it.whenTemplateMissing == "generic" || it.whenTemplateMissing == "repoCopy") &&
            resolvedTemplateMissing(it, bankIds, bankLoaded)
    }.map { it.key }

