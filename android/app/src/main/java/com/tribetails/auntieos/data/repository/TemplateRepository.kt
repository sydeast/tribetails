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
     * Stage 2 tail: the distinct set of template catalog keys currently in use, via
     * the read-only listCatalogKeys callable. Optional case-insensitive substring
     * filter. These are the keys the dispatcher knows about; comparing them against
     * the bound catalog keys yields the "unbound" set surfaced in Template Assignment.
     */
    suspend fun listCatalogKeys(filter: String? = null): Result<List<String>> = runCatching {
        val payload = buildMap<String, Any> {
            filter?.takeIf { it.isNotBlank() }?.let { put("filter", it) }
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listCatalogKeys").call(payload).await().data as? Map<String, Any?>
            ?: error("listCatalogKeys: non-map payload")
        (raw["keys"] as? List<*>).orEmpty().mapNotNull { it as? String }
    }.onFailure { AuntieLog.e("TemplateRepository.listCatalogKeys failed", it) }
}

/**
 * Pure: catalog keys that exist in the dispatcher's catalog but have no binding doc.
 * [catalogKeys] is the listCatalogKeys result; [boundKeys] is the set of catalogKey
 * values from listBindings. Returns the unbound keys, sorted, with blanks dropped.
 * Pure; unit-tested. Mirrors the web unbound-keys diff.
 */
internal fun unboundCatalogKeys(catalogKeys: List<String>, boundKeys: Collection<String>): List<String> {
    val bound = boundKeys.filter { it.isNotBlank() }.toSet()
    return catalogKeys.filter { it.isNotBlank() && it !in bound }.distinct().sorted()
}
