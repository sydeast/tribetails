package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * Admin-side wrapper for email-template + binding callables.
 *
 * Templates live at `emailTemplates/{id}` (subject/body/html/tags/category/title).
 * Bindings live at `notificationTemplateBindings/{catalogKey}` and override the
 * dispatcher's default catalog-key → template lookup.
 *
 * All four callables are admin-claim-gated server-side (wrapAdminCallable).
 */
class TemplateRepository(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
) {

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

    /**
     * One row of the routing table, from listCatalogKeys.
     *
     * [defaultTemplateId] is what dispatch falls back to with no binding, which for
     * every catalog row is the key itself: `lib/sendFromTemplate.ts` looks for
     * `notificationTemplateBindings/{key}` and, finding nothing, reads
     * `emailTemplates/{key}`. [resolvedTemplateId] is what it sends today. When the
     * two differ, a binding is overriding the default.
     */
    data class CatalogKey(
        val key: String,
        val label: String,
        val category: String?,
        val audience: String?,
        /** 'catalog', 'direct-send', or 'legacy'. */
        val source: String,
        val defaultTemplateId: String,
        val hasDefaultTemplate: Boolean,
        val bound: Boolean,
        val resolvedTemplateId: String,
    )

    suspend fun listTemplates(): Result<List<EmailTemplate>> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listTemplates").call(emptyMap<String, Any>()).await().data as? Map<String, Any?>
            ?: error("listTemplates: non-map payload")
        val list = (raw["templates"] as? List<*>).orEmpty()
        list.mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            EmailTemplate(
                templateId = m["templateId"] as? String ?: return@mapNotNull null,
                subject = m["subject"] as? String ?: "",
                body = m["body"] as? String ?: "",
                html = m["html"] as? String,
                title = m["title"] as? String ?: (m["templateId"] as? String ?: ""),
                description = m["description"] as? String,
                tags = ((m["tags"] as? List<*>).orEmpty()).mapNotNull { it as? String },
                category = m["category"] as? String,
            )
        }
    }.onFailure { AuntieLog.e("TemplateRepository.listTemplates failed", it) }

    /**
     * Server-deduped category list (hybrid: managed `template_categories` ∪ distinct
     * categories already on templates). Mirrors web `TemplateService.listCategories`.
     */
    suspend fun listCategories(): Result<List<String>> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listCategories").call(emptyMap<String, Any>()).await().data as? Map<String, Any?>
            ?: error("listCategories: non-map payload")
        (raw["categories"] as? List<*>).orEmpty().mapNotNull { it as? String }
    }.onFailure { AuntieLog.e("TemplateRepository.listCategories failed", it) }

    suspend fun listBindings(): Result<List<TemplateBinding>> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listTemplateBindings").call(emptyMap<String, Any>()).await().data as? Map<String, Any?>
            ?: error("listTemplateBindings: non-map payload")
        val list = (raw["bindings"] as? List<*>).orEmpty()
        list.mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            TemplateBinding(
                catalogKey = m["catalogKey"] as? String ?: return@mapNotNull null,
                templateId = m["templateId"] as? String ?: "",
                audience = m["audience"] as? String,
                triggerKey = m["triggerKey"] as? String,
                active = m["active"] as? Boolean ?: false,
            )
        }
    }.onFailure { AuntieLog.e("TemplateRepository.listBindings failed", it) }

    suspend fun saveTemplate(template: EmailTemplate): Result<String> = runCatching {
        val payload = buildMap<String, Any> {
            put("templateId", template.templateId)
            put("subject", template.subject)
            put("body", template.body)
            template.html?.let { put("html", it) }
            put("title", template.title)
            template.description?.let { put("description", it) }
            put("tags", template.tags)
            template.category?.let { put("category", it) }
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveTemplate").call(payload).await().data as? Map<String, Any?>
            ?: error("saveTemplate: non-map payload")
        raw["templateId"] as? String ?: error("saveTemplate: missing templateId")
    }.onFailure { AuntieLog.e("TemplateRepository.saveTemplate failed", it) }

    suspend fun assignTemplate(
        catalogKey: String,
        templateId: String,
        audience: String? = null,
        triggerKey: String? = null,
        active: Boolean = true,
    ): Result<Unit> = runCatching {
        val payload = buildMap<String, Any> {
            put("catalogKey", catalogKey)
            put("templateId", templateId)
            audience?.let { put("audience", it) }
            triggerKey?.let { put("triggerKey", it) }
            put("active", active)
        }
        functions.getHttpsCallable("assignTemplate").call(payload).await()
        Unit
    }.onFailure { AuntieLog.e("TemplateRepository.assignTemplate failed", it) }

    /**
     * AO-56: remove the binding for [catalogKey] (deletes
     * notificationTemplateBindings/{catalogKey}). The inverse of [assignTemplate]
     * and the half that used to be missing: without it a bound template could
     * never be deleted, since deleteTemplate refuses while a binding points at
     * it. Idempotent server-side (removed:false when the key was already gone);
     * returns that flag so the UI can distinguish "unassigned" from "was already
     * unassigned".
     */
    suspend fun unassignTemplate(catalogKey: String): Result<Boolean> = runCatching {
        val payload = mapOf("catalogKey" to catalogKey)
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("unassignTemplate").call(payload).await().data as? Map<String, Any?>
            ?: error("unassignTemplate: non-map payload")
        raw["removed"] as? Boolean ?: false
    }.onFailure { AuntieLog.e("TemplateRepository.unassignTemplate failed", it) }

    /**
     * The routing table: every catalog key, and what it sends right now.
     *
     * `resolvedTemplateId` is the server's own answer, computed the same way
     * `resolveTemplateId` computes it at send time, including the rule that an
     * INACTIVE binding falls back to the name-matched default rather than sending
     * nothing. Comparing it with [CatalogKey.defaultTemplateId] is how a client
     * tells an override from a default without re-implementing the rule.
     *
     * Optional case-insensitive substring filter on key or label.
     */
    suspend fun listCatalogKeys(filter: String? = null): Result<List<CatalogKey>> = runCatching {
        val payload = buildMap<String, Any> {
            filter?.takeIf { it.isNotBlank() }?.let { put("filter", it) }
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listCatalogKeys").call(payload).await().data as? Map<String, Any?>
            ?: error("listCatalogKeys: non-map payload")
        (raw["rows"] as? List<*>).orEmpty().mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            val key = m["key"] as? String ?: return@mapNotNull null
            // A row missing defaultTemplateId would make every key look overridden,
            // so it falls back to the key, which is what the naming convention says.
            val default = m["defaultTemplateId"] as? String ?: key
            CatalogKey(
                key = key,
                label = m["label"] as? String ?: key,
                category = m["category"] as? String,
                audience = m["audience"] as? String,
                source = m["source"] as? String ?: "catalog",
                defaultTemplateId = default,
                hasDefaultTemplate = m["hasDefaultTemplate"] as? Boolean ?: false,
                bound = m["bound"] as? Boolean ?: false,
                resolvedTemplateId = m["resolvedTemplateId"] as? String ?: default,
            )
        }
    }.onFailure { AuntieLog.e("TemplateRepository.listCatalogKeys failed", it) }
}

/**
 * Pure: whether a binding is actually steering [row] right now.
 *
 * Read off the server's resolution rather than recomputed: `resolveTemplateId`
 * falls back to the default when a binding is missing OR paused, and
 * `resolvedTemplateId` already reflects that. Mirrors the web helper of the same name.
 */
internal fun isOverridden(row: TemplateRepository.CatalogKey): Boolean =
    row.resolvedTemplateId != row.defaultTemplateId

/**
 * Pure: where the template this key sends came from, in words. Mirrors the web copy
 * exactly, so the two screens cannot drift into telling different stories.
 */
internal fun routingSource(row: TemplateRepository.CatalogKey): String = when {
    isOverridden(row) -> "override, assigned by an admin"
    row.bound -> "binding is paused, so the name-matched default applies"
    else -> "default, matched by name"
}

/**
 * Pure: whether the template this key resolves to is actually missing.
 *
 * For a name-matched default the server already checked ([CatalogKey.hasDefaultTemplate]).
 * For an override the check is against the loaded bank, and only when the bank loaded:
 * an unavailable listTemplates must not paint every override as broken.
 */
internal fun resolvedTemplateMissing(
    row: TemplateRepository.CatalogKey,
    bankTemplateIds: Set<String>,
    bankLoaded: Boolean,
): Boolean =
    if (isOverridden(row)) bankLoaded && row.resolvedTemplateId !in bankTemplateIds
    else !row.hasDefaultTemplate
