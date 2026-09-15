package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog

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

    /** One channel's outcome inside an import report row. */
    data class ImportChannel(
        val channel: String,
        val outcome: String,
        val notes: List<String>,
    )
    /** One template's line of the import report. */
    data class ImportRow(
        val templateId: String,
        /** Set when this id is a retired key kept alive for older bindings. */
        val aliasOf: String?,
        val channels: List<ImportChannel>,
        val differsFromRepo: Boolean,
        val blocked: Boolean,
        /** Why the template was refused, one sentence each. Empty unless [blocked] (#892 review 2). */
        val issues: List<String> = emptyList(),
    )
    /**
     * What an import did, or would do.
     *
     * [written] is documents, not templates, and is always zero on a dry run.
     * [needsOverwriteChoice] names the templates whose stored copy differs from
     * the repo copy and which were therefore left alone; importing one of those
     * takes a second call naming it in `overwriteIds`.
     */
    data class ImportReport(
        val dryRun: Boolean,
        val written: Int,
        val counts: Map<String, Int>,
        val rows: List<ImportRow>,
        val needsOverwriteChoice: List<String>,
        val refused: List<Pair<String, String>>,
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
        val raw = functions.getHttpsCallable("listTemplates").call(emptyMap<String, Any>()).awaitCallable().data as? Map<String, Any?>
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
        val raw = functions.getHttpsCallable("listCategories").call(emptyMap<String, Any>()).awaitCallable().data as? Map<String, Any?>
            ?: error("listCategories: non-map payload")
        (raw["categories"] as? List<*>).orEmpty().mapNotNull { it as? String }
    }.onFailure { AuntieLog.e("TemplateRepository.listCategories failed", it) }

    suspend fun listBindings(): Result<List<TemplateBinding>> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listTemplateBindings").call(emptyMap<String, Any>()).awaitCallable().data as? Map<String, Any?>
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

    /**
     * Upserts a template, or creates one.
     *
     * [expectNew] rides along only from the New Template path. With it set the
     * server refuses a key that is already taken instead of replacing whatever
     * is stored under it. The editor's own collision check is a fast path over
     * the page of templates it happens to hold; this is the one that is true.
     */
    suspend fun saveTemplate(
        template: EmailTemplate,
        expectNew: Boolean = false,
    ): Result<String> = runCatching {
        val payload = buildMap<String, Any> {
            put("templateId", template.templateId)
            put("subject", template.subject)
            put("body", template.body)
            template.html?.let { put("html", it) }
            put("title", template.title)
            template.description?.let { put("description", it) }
            put("tags", template.tags)
            template.category?.let { put("category", it) }
            if (expectNew) put("expectNew", true)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveTemplate").call(payload).awaitCallable().data as? Map<String, Any?>
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
        functions.getHttpsCallable("assignTemplate").call(payload).awaitCallable()
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
        val raw = functions.getHttpsCallable("unassignTemplate").call(payload).awaitCallable().data as? Map<String, Any?>
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
        val raw = functions.getHttpsCallable("listCatalogKeys").call(payload).awaitCallable().data as? Map<String, Any?>
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
    /**
     * Loads the notification templates committed to the repo into Firestore.
     *
     * Issue #468. The operator ruled out the seed script, and a notification
     * whose template document is missing does not fall back to anything: the
     * channel sender throws and no email goes out. This is the route that
     * replaces the script, and it is the same callable the web admin uses.
     *
     * [dryRun] defaults to true, so a caller that forgets the argument plans
     * rather than writes. A template whose stored copy differs from the repo
     * copy is skipped unless its id is in [overwriteIds], which is how an
     * import can never quietly replace wording someone edited in the Bank.
     */
    suspend fun importSeedTemplates(
        dryRun: Boolean = true,
        overwriteIds: List<String> = emptyList(),
        onlyIds: List<String> = emptyList(),
    ): Result<ImportReport> = runCatching {
        val payload = buildMap<String, Any> {
            put("dryRun", dryRun)
            if (overwriteIds.isNotEmpty()) put("overwriteIds", overwriteIds)
            if (onlyIds.isNotEmpty()) put("onlyIds", onlyIds)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("importSeedTemplates").call(payload).awaitCallable().data as? Map<String, Any?>
            ?: error("importSeedTemplates: non-map payload")
        decodeImportReport(raw)
    }.onFailure { AuntieLog.e("TemplateRepository.importSeedTemplates failed", it) }
}
/**
 * Pure: turns the callable's payload into an [TemplateRepository.ImportReport].
 *
 * Split out of the repo so the JVM suite can exercise the decoding without a
 * mocked Firebase, and because a report the phone cannot read is a report an
 * operator acts on blind. A row missing its id is dropped rather than guessed
 * at, matching how `listCatalogKeys` handles the same problem.
 */
internal fun decodeImportReport(raw: Map<String, Any?>): TemplateRepository.ImportReport {
    val rows = (raw["rows"] as? List<*>).orEmpty().mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        val templateId = m["templateId"] as? String ?: return@mapNotNull null
        TemplateRepository.ImportRow(
            templateId = templateId,
            aliasOf = m["aliasOf"] as? String,
            channels = (m["channels"] as? List<*>).orEmpty().mapNotNull { c ->
                val cm = c as? Map<*, *> ?: return@mapNotNull null
                TemplateRepository.ImportChannel(
                    channel = cm["channel"] as? String ?: return@mapNotNull null,
                    outcome = cm["outcome"] as? String ?: "unknown",
                    notes = (cm["notes"] as? List<*>).orEmpty().mapNotNull { it as? String },
                )
            },
            differsFromRepo = m["differsFromRepo"] as? Boolean ?: false,
            blocked = m["blocked"] as? Boolean ?: false,
            issues = (m["issues"] as? List<*>).orEmpty().mapNotNull { it as? String },
        )
    }
    val counts = (raw["counts"] as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
        val name = k as? String ?: return@mapNotNull null
        name to ((v as? Number)?.toInt() ?: return@mapNotNull null)
    }.toMap()
    return TemplateRepository.ImportReport(
        // Absent means dry run, the same default the server applies. Reading a
        // silent absence as "it wrote" is the one mistake with consequences.
        dryRun = raw["dryRun"] as? Boolean ?: true,
        written = (raw["written"] as? Number)?.toInt() ?: 0,
        counts = counts,
        rows = rows,
        needsOverwriteChoice = (raw["needsOverwriteChoice"] as? List<*>).orEmpty().mapNotNull { it as? String },
        refused = (raw["refused"] as? List<*>).orEmpty().mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            val id = m["templateId"] as? String ?: return@mapNotNull null
            id to (m["reason"] as? String ?: "Refused.")
        },
    )
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
