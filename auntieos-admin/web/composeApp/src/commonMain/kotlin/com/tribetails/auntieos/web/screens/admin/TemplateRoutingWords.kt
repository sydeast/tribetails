package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.TemplateService
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
 * The template a binding sends, named. An id the bank does not hold is "a template
 * not in the bank"; before the bank loads the card says "its template". Never the id.
 */
internal fun routedTemplateName(templateId: String, namesById: Map<String, String>, bankLoaded: Boolean): String =
    namesById[templateId] ?: if (bankLoaded) "a template not in the bank" else "its template"

/** The trigger a binding overrides, as words, or null when it is not a genuine override. */
internal fun triggerLine(binding: TemplateService.TemplateBinding): String? =
    genuineTriggerOverride(binding.triggerKey, binding.catalogKey)?.let { "Trigger: ${humanizeKey(it)}" }

/** The binding editor's title: "New Binding", else the notification's name. */
internal fun bindingDialogTitle(binding: TemplateService.TemplateBinding, isNew: Boolean, rows: List<CatalogKeyRow>): String =
    if (isNew) "New Binding" else "Edit: ${catalogKeyNameFor(binding.catalogKey, rows)}"

/** The binding editor's hint, with no database name in it. */
internal const val BINDING_DIALOG_HINT =
    "Pick the template this notification sends by email. Audience and trigger are optional and stored with it."

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
