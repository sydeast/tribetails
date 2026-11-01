package com.kinfolk.portal.util
private val AUNTIE_WORD = Regex("\\bauntie\\b", RegexOption.IGNORE_CASE)
/**
 * #1322. An Auntie's name with the role word in front, said once: "Maya" reads
 * "Auntie Maya", but a display name that already carries the word ("TEST
 * SANDBOX Auntie", "Auntie Maya") is left as it is. The name is the operator's
 * setting and is never rewritten; only the prefix is skipped.
 *
 * Mirrors `auntieName` in mytribe/web/src/lib/portalFormat.ts, so the portal web
 * and this app print the same byline.
 *
 * Null for a missing or blank name, so each caller keeps its own fallback.
 */
fun auntieName(displayName: String?): String? {
    val name = displayName?.trim().orEmpty()
    if (name.isEmpty()) return null
    return if (AUNTIE_WORD.containsMatchIn(name)) name else "Auntie $name"
}
