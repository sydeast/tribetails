package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.resolvedTemplateMissing
import com.tribetails.auntieos.web.screens.humanizeKey

/**
 * #1592: Template Routing in the operator's words. Display only: the catalog key
 * and template id are still what the screen stores, sends and matches on. Mirrors
 * the web `lib/templateRoutingFormat.ts` and Android `ui/admin/TemplateRoutingWords.kt`,
 * so the clients say the same words.
 */

/**
 * A notification's name: the catalog label, else the key as words, never the key.
 * A legacy stray's label is the server's sentence "Not in the catalog, nothing
 * dispatches it", which is not a name, so it reads as words too.
 */
internal fun catalogKeyName(row: CatalogKeyRow): String {
    val key = row.key.trim()
    val label = row.label.trim()
    if (row.source != "legacy" && label.isNotEmpty() && label != key) return label
    return humanizeKey(key).ifEmpty { "Notification" }
}

/** The name for a key the screen holds on its own (a binding, a list), looked up in the routing rows. */
internal fun catalogKeyNameFor(key: String, rows: List<CatalogKeyRow>): String =
    rows.firstOrNull { it.key == key }?.let(::catalogKeyName)
        ?: humanizeKey(key).ifEmpty { "Notification" }

/**
 * What a Template Bank doc is called: its title, else its subject, never its id.
 * listTemplates answers a doc with no title with its id, so a title equal to the id
 * is no title at all.
 */
internal fun bankTemplateName(t: TemplateService.EmailTemplate): String {
    val id = t.templateId.trim()
    return listOf(t.title, t.subject)
        .map { it.trim() }
        .firstOrNull { it.isNotEmpty() && it != id }
        ?: "Untitled template"
}

/**
 * The template a row sends, named. [knownToExist] is the server's word that a
 * name-matched default is in the bank; it reads "its own template" when the loaded
 * bank cannot name it. An id the bank does not hold is "a template not in the bank",
 * and before the bank loads the row says "its template". Never the id.
 */
internal fun routedTemplateName(
    templateId: String,
    namesById: Map<String, String>,
    bankLoaded: Boolean,
    knownToExist: Boolean = false,
): String = namesById[templateId]
    ?: when {
        knownToExist -> "its own template"
        bankLoaded -> "a template not in the bank"
        else -> "its template"
    }

/** The failing-keys banner sentence, naming each notification. */
internal fun failingKeysLine(failing: List<String>, loadable: List<String>, rows: List<CatalogKeyRow>): String {
    val names = failing.joinToString(", ") { catalogKeyNameFor(it, rows) }
    val load = if (loadable.isEmpty()) "" else
        " The repo has a copy of ${loadable.joinToString(", ") { catalogKeyNameFor(it, rows) }}. Load it from Template Import."
    return "The template does not exist: $names.$load"
}

/** The awaiting-import banner sentence, naming each notification. */
internal fun awaitingImportLine(awaiting: List<String>, rows: List<CatalogKeyRow>): String =
    "${awaiting.joinToString(", ") { catalogKeyNameFor(it, rows) }}. Load them from Template Import."

// ── #1739: the routing table, the shape web and Android moved to in #384 ──────

/**
 * Whether a binding is actually steering [row] right now. Read off the server's
 * resolution, which already falls back to the default when a binding is missing
 * or paused. Android `isOverridden`, web `isOverridden`.
 */
internal fun isOverridden(row: CatalogKeyRow): Boolean = row.resolvedTemplateId != row.defaultTemplateId

/** Where the template a row sends came from, in words. Same copy as web and Android. */
internal fun routingSource(row: CatalogKeyRow): String = when {
    isOverridden(row) -> "override, assigned by an admin"
    row.bound -> "binding is paused, so the name-matched default applies"
    else -> "default, matched by name"
}

/** Whether this row's next send FAILS: only when the server says a missing template fails it (#1586). */
internal fun failsOnSend(row: CatalogKeyRow, bankIds: Set<String>, bankLoaded: Boolean): Boolean =
    row.whenTemplateMissing == "fails" && resolvedTemplateMissing(row, bankIds, bankLoaded)


/**
 * The quiet line under a row whose template is missing, or null. A send that
 * still goes out says what goes out; a failing send gets the loud line, and this
 * only says the repo has a copy Template Import can load. Android `missingTemplateNote`.
 */
internal fun missingTemplateNote(row: CatalogKeyRow, templateMissing: Boolean): String? {
    if (row.whenTemplateMissing == "unused") {
        return if (row.source == "legacy") null else "Written when it is sent, so no template is used."
    }
    if (!templateMissing) return null
    val load = if (row.inRepoCorpus) " Load it from Template Import." else ""
    return when (row.whenTemplateMissing) {
        "generic" -> "Not in the bank yet, so this sends generic wording that cannot say what happened.$load"
        "repoCopy" -> "Not in the bank yet, so this sends the repo copy.$load"
        else -> if (row.inRepoCorpus) "The repo has a copy. Load it from Template Import." else null
    }
}

/** #1592: Template Routing copy, with no database path and no function name. */
internal const val TEMPLATE_MISSING_LINE = "The template this sends is missing, so its next send fails."

internal const val ROUTING_TABLE_EMPTY =
    "No notifications came back. This list comes with the app, so an empty one means something " +
        "is broken. Reload, and report it if it stays empty."

/** The editor's hint, with no database name in it. Same words as Android. */
internal const val OVERRIDE_DIALOG_HINT =
    "Without an override this sends its own template, matched by name. Saving here points it at " +
        "another one, for email only."

/** The routing row's subtitle: what it sends, where that came from, and any audience or trigger. */
internal fun routingRowSubtitle(
    row: CatalogKeyRow,
    binding: TemplateService.TemplateBinding?,
    namesById: Map<String, String>,
    bankLoaded: Boolean,
    missing: Boolean,
    missingNote: String?,
): String = buildString {
    val sends = routedTemplateName(
        row.resolvedTemplateId,
        namesById,
        bankLoaded,
        knownToExist = !isOverridden(row) && row.hasDefaultTemplate,
    )
    append("sends $sends")
    append("\n${routingSource(row)}")
    binding?.audience?.let { append("\nAudience: $it (stored, no sender reads it)") }
    // Only a GENUINE trigger override echoes: the server defaults a blank
    // triggerKey to the catalogKey, so the guard stops it firing on every binding.
    genuineTriggerOverride(binding?.triggerKey, row.key)?.let { append("\nTrigger: ${humanizeKey(it)}") }
    if (missing) append("\n$TEMPLATE_MISSING_LINE")
    missingNote?.let { append("\n$it") }
}

/** The row's action: the web's "Override" / "Change override". */
internal fun routingActionLabel(row: CatalogKeyRow): String = if (row.bound) "Change override" else "Override"

/** The editor's title: the notification's name, never `Override: <key>`. */
internal fun overrideDialogTitle(row: CatalogKeyRow): String =
    if (row.bound) "Change override: ${catalogKeyName(row)}" else "Override: ${catalogKeyName(row)}"

/** The line over the table: how many route, how many through an override. */
internal fun routingSummary(rows: List<CatalogKeyRow>): String {
    val overrides = rows.count(::isOverridden)
    return "${rows.size} notifications route today. $overrides of them through an override, the rest by name."
}

/** The search over the routing table: the notification's name or key, and the template's name or id. */
internal fun filterRoutingRows(
    rows: List<CatalogKeyRow>,
    query: String,
    templateNames: Map<String, String>,
): List<CatalogKeyRow> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return rows
    return rows.filter {
        it.key.lowercase().contains(q) ||
            catalogKeyName(it).lowercase().contains(q) ||
            it.resolvedTemplateId.lowercase().contains(q) ||
            templateNames[it.resolvedTemplateId].orEmpty().lowercase().contains(q)
    }
}
