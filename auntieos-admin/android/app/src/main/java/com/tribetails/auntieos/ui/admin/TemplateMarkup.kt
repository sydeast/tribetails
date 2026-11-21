package com.tribetails.auntieos.ui.admin

/**
 * #2251: the sentence for a template field whose `{{#if}}` blocks do not pair
 * up, or that holds half a merge field, or null when it sends. Before this a
 * subject like `{{#if isQuote}}Your quote is ready` saved from this phone's
 * Markdown editor, and every send of that notice then failed while the
 * household heard nothing. (The visual editor already held Save back through
 * [hasBrokenMergeField], #2239.)
 *
 * The same sentences the server's `saveTemplate` refuses with
 * (`mytribe/functions/src/lib/templateValidation.ts`), the web editor shows
 * (`auntieos-admin/src/lib/templateFormat.ts#templateMarkupError`) and the
 * desktop console shows (composeApp `TemplateMarkup.kt`). Narrower
 * than the server: it only catches what it can be sure of, and the server is
 * the last word on the rest.
 *
 * @param label the field as the editor names it: "The subject", "The body".
 */
fun templateMarkupError(label: String, value: String): String? {
    if (!value.contains("{{") && !value.contains("}}")) return null
    fun fail(detail: String) = "$label cannot be sent as written. $detail"
    // A comment or an escaped `\{{` is never filled in, so a tag written inside
    // one pairs with nothing and still sends (#2251 review).
    val read = NOT_MARKUP.replace(value, "")
    val open = ArrayDeque<String>()
    for (m in BLOCK_TAG.findAll(read)) {
        val opener = m.groups[2]?.value
        val closer = m.groups[3]?.value
        when {
            opener != null -> open.addLast(opener)
            closer != null -> {
                val top = open.removeLastOrNull()
                    ?: return fail("{{/$closer}} closes a part that was never opened. Remove it, or add the {{#$closer}} it belongs to.")
                if (top != closer) return fail("{{#$top}} is closed with {{/$closer}}. Close it with {{/$top}}.")
            }
            open.isEmpty() ->
                return fail("{{else}} sits outside any {{#if}}. Move it between an {{#if}} and its {{/if}}, or remove it.")
        }
    }
    open.removeLastOrNull()?.let { return fail("{{#$it}} is never closed. Add {{/$it}} where that part ends.") }
    // Half a field: `{{kinName` with no closing brackets before the next field.
    if (read.split("{{").drop(1).any { !it.contains("}}") }) {
        return fail("A field is not written correctly. Each field needs two curly brackets on both sides, like {{kinName}}.")
    }
    return null
}

/** `{{!-- note --}}`, `{{! note}}` and an escaped `\{{field}}`: text the sender prints or drops, never fills. */
private val NOT_MARKUP = Regex("""\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}|\\\{\{[\s\S]*?\}\}""")

/** `{{#if x}}`, `{{^if x}}`, `{{else}}`, `{{/if}}`, read for pairing only. */
private val BLOCK_TAG =
    Regex("""\{\{~?\s*(?:([#^])\s*([A-Za-z_][\w-]*)|/\s*([A-Za-z_][\w-]*)|(else))\b[^}]*?~?\}\}""")
