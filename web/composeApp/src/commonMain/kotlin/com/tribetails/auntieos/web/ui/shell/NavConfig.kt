package com.tribetails.auntieos.web.ui.shell

/**
 * 17.4 Nav editor (web/desktop). Pure, String-key model for the operator-editable
 * navigation, persisted to UserProfile.navConfig as ordered tokens "key" or
 * "key|Custom Label". A known key absent from the list = hidden; an empty list = the
 * shipped default (un-customized nav reads byte-identical to pre-17.4). Keys are
 * Destination.name values; labels fall back to Destination.title. Free of Compose so
 * it is unit-testable on the JVM; mirrored on android. See NavConfigTest.
 */

/** One nav entry: a destination [key] with an optional operator [customLabel]. */
data class NavEntry(val key: String, val customLabel: String? = null) {
    /** The label to show: the operator override when set, else the [fallback] title. */
    fun label(fallback: String): String = customLabel?.takeIf { it.isNotBlank() } ?: fallback
}

/**
 * Parse "key" / "key|Custom Label" tokens into entries: drop keys not in [known],
 * dedupe (first wins), blank custom label -> null.
 */
fun parseNavTokens(tokens: List<String>, known: Set<String>): List<NavEntry> {
    val seen = mutableSetOf<String>()
    val out = mutableListOf<NavEntry>()
    for (raw in tokens) {
        val sep = raw.indexOf('|')
        val key = (if (sep >= 0) raw.substring(0, sep) else raw).trim()
        if (key !in known || !seen.add(key)) continue
        val custom = if (sep >= 0) raw.substring(sep + 1).trim().ifBlank { null } else null
        out.add(NavEntry(key, custom))
    }
    return out
}

/**
 * Effective nav at load: the saved custom config, or the [defaultOrder] (all keys,
 * default labels) when nothing is stored.
 */
fun resolvedNav(tokens: List<String>, defaultOrder: List<String>): List<NavEntry> {
    val known = defaultOrder.toSet()
    return if (tokens.isEmpty()) defaultOrder.map { NavEntry(it) }
    else parseNavTokens(tokens, known).ifEmpty { defaultOrder.map { NavEntry(it) } }
}

/** Serialize entries back to tokens for saveUserProfile. */
fun List<NavEntry>.toNavTokens(): List<String> =
    map { e -> if (e.customLabel.isNullOrBlank()) e.key else "${e.key}|${e.customLabel}" }

/** Known keys not currently shown, in [defaultOrder] order (the "hidden" strip). */
fun hiddenNavKeys(shown: List<NavEntry>, defaultOrder: List<String>): List<String> {
    val shownKeys = shown.map { it.key }.toSet()
    return defaultOrder.filter { it !in shownKeys }
}

fun moveNavUp(list: List<NavEntry>, index: Int): List<NavEntry> {
    if (index <= 0 || index >= list.size) return list
    val out = list.toMutableList()
    out[index - 1] = list[index]; out[index] = list[index - 1]
    return out
}

fun moveNavDown(list: List<NavEntry>, index: Int): List<NavEntry> {
    if (index < 0 || index >= list.size - 1) return list
    val out = list.toMutableList()
    out[index + 1] = list[index]; out[index] = list[index + 1]
    return out
}

/** Set (or clear, when blank) a custom label for [key]. */
fun renameNav(list: List<NavEntry>, key: String, label: String): List<NavEntry> =
    list.map { if (it.key == key) it.copy(customLabel = label.trim().ifBlank { null }) else it }

fun hideNav(list: List<NavEntry>, key: String): List<NavEntry> = list.filterNot { it.key == key }

fun showNav(list: List<NavEntry>, key: String): List<NavEntry> =
    if (list.any { it.key == key }) list else list + NavEntry(key)
