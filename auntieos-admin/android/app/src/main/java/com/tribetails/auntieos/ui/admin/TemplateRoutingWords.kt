package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.data.repository.routingSource

/**
 * #1592: Template Routing in the operator's words. Display only: the catalog key
 * and template id are still what the screen stores, sends and matches on. Mirrors
 * the web `lib/templateRoutingFormat.ts` and the desktop console's
 * `screens/admin/TemplateRoutingWords.kt`, so the clients say the same words.
 */

/**
 * A notification's name: the catalog label, else the key as words, never the key.
 * A legacy stray's label is the server's sentence "Not in the catalog, nothing
 * dispatches it", which is not a name, so it reads as words too.
 */
fun catalogKeyName(row: TemplateRepository.CatalogKey): String {
    val key = row.key.trim()
    val label = row.label.trim()
    if (row.source != "legacy" && label.isNotEmpty() && label != key) return label
    return humanizeKey(key).ifEmpty { "Notification" }
}

/** The name for a key the screen holds on its own, looked up in the routing rows. */
fun catalogKeyNameFor(key: String, rows: List<TemplateRepository.CatalogKey>): String =
    rows.firstOrNull { it.key == key }?.let(::catalogKeyName)
        ?: humanizeKey(key).ifEmpty { "Notification" }

/**
 * What a Template Bank doc is called: its title, else the visual headline, else the
 * subject, never its id. listTemplates answers a doc with no title with its id, so a
 * title equal to the id is no title at all.
 */
fun bankTemplateName(t: TemplateRepository.EmailTemplate): String {
    val id = t.templateId.trim()
    return listOf(t.title, t.headline, t.subject)
        .map { it?.trim().orEmpty() }
        .firstOrNull { it.isNotEmpty() && it != id }
        ?: "Untitled template"
}

/**
 * The template a row sends, named. [knownToExist] is the server's word that a
 * name-matched default is in the bank; it reads "its own template" when the loaded
 * bank cannot name it. An id the bank does not hold is "a template not in the bank",
 * and before the bank loads the row says "its template". Never the id.
 */
fun routedTemplateName(
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

/** The routing row's subtitle: what it sends, where that came from, and any trigger. */
internal fun routingRowSubtitle(
    row: TemplateRepository.CatalogKey,
    binding: TemplateRepository.TemplateBinding?,
    namesById: Map<String, String>,
    bankLoaded: Boolean,
    missing: Boolean,
    missingNote: String?,
): String = buildString {
    val overridden = row.resolvedTemplateId != row.defaultTemplateId
    val sends = routedTemplateName(
        row.resolvedTemplateId,
        namesById,
        bankLoaded,
        knownToExist = !overridden && row.hasDefaultTemplate,
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

/** The editor's title: the notification's name, never `Override: <key>`. */
internal fun overrideDialogTitle(row: TemplateRepository.CatalogKey): String =
    if (row.bound) "Edit override: ${catalogKeyName(row)}" else "Override: ${catalogKeyName(row)}"

/** The routing table's "awaiting import" sentence, naming each notification. */
internal fun awaitingImportLine(rows: List<TemplateRepository.CatalogKey>): String =
    "Not in the bank yet, still delivered: ${rows.joinToString(", ") { catalogKeyName(it) }}. " +
        "Load them from Template Import."
