package com.tribetails.auntieos.web.screens.admin

/**
 * #2251: the sentence for a template field whose `{{#if}}` blocks do not pair
 * up, or that holds half a merge field, or null when it sends. Before this a
 * subject like `{{#if isQuote}}Your quote is ready` saved from the desktop
 * console, and every send of that notice then failed while the household heard
 * nothing.
 *
 * The same sentences the server's `saveTemplate` refuses with
 * (`mytribe/functions/src/lib/templateValidation.ts`) and the web editor shows
 * (`auntieos-admin/src/lib/templateFormat.ts#templateMarkupError`). Narrower
 * than the server: it only catches what it can be sure of, and the server is
 * the last word on the rest.
 *
 * @param label the field as the editor names it: "The subject", "The body".
 */
fun templateMarkupError(label: String, value: String): String? {
    if (!value.contains("{{") && !value.contains("}}")) return null
    fun fail(detail: String) = "$label cannot be sent as written. $detail"
    val open = ArrayDeque<String>()
    for (m in BLOCK_TAG.findAll(value)) {
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
    if (value.split("{{").drop(1).any { !it.contains("}}") }) {
        return fail("A field is not written correctly. Each field needs two curly brackets on both sides, like {{kinName}}.")
    }
    return null
}

/** `{{#if x}}`, `{{^if x}}`, `{{else}}`, `{{/if}}`, read for pairing only. */
private val BLOCK_TAG =
    Regex("""\{\{~?\s*(?:([#^])\s*([A-Za-z_][\w-]*)|/\s*([A-Za-z_][\w-]*)|(else))\b[^}]*?~?\}\}""")
