package com.tribetails.auntieos.ui.admin

/**
 * #957: the Email frame panel's draft, as pure functions (the web twin is
 * `auntieos-admin/src/lib/emailFrameDraft.ts`).
 *
 * A draft holds one string per field, and "" means "the default". A default is
 * shown (as a placeholder, or as the color a swatch paints) but never enters
 * the draft, so it is never sent (D-DEFAULT-IS-HINT).
 *
 * DIFF, NEVER REBUILD. A save sends only the fields whose draft differs from
 * what was loaded. A field the server holds that this panel has no control for
 * is not in the draft at all, so it is never in the diff and never wiped.
 */
object EmailFrameFields {
    /** Color fields, in the order the panel shows them. */
    val COLORS: List<String> = listOf(
        "accentColor",
        "headlineColor",
        "textColor",
        "buttonTextColor",
        "pageBackground",
        "cardBackground",
        "calloutBackground",
        "footerBackground",
        "footerTextColor",
    )
    const val HEADER_TEXT = "headerText"
    const val FOOTER_TEXT = "footerText"
    const val LOGO_URL = "logoUrl"
    val ALL: List<String> = COLORS + listOf(HEADER_TEXT, FOOTER_TEXT, LOGO_URL)

    const val HEADER_TEXT_MAX = 80
    const val FOOTER_TEXT_MAX = 300

    val LABELS: Map<String, String> = mapOf(
        "accentColor" to "Accent",
        "headlineColor" to "Headline",
        "textColor" to "Text",
        "buttonTextColor" to "Button text",
        "pageBackground" to "Page",
        "cardBackground" to "Card",
        "calloutBackground" to "Callout",
        "footerBackground" to "Footer",
        "footerTextColor" to "Footer text",
    )
}

private val HEX = Regex("^#[0-9a-fA-F]{6}$")

fun emailFrameDraftFrom(stored: Map<String, String>): Map<String, String> =
    EmailFrameFields.ALL.associateWith { stored[it] ?: "" }

private fun normalize(field: String, value: String): String {
    val t = value.trim()
    return if (field in EmailFrameFields.COLORS) t.lowercase() else t
}

/** The fields to send: a new value, or null for "back to the default". Empty when nothing changed. */
fun emailFrameChanges(draft: Map<String, String>, stored: Map<String, String>): Map<String, String?> {
    val out = linkedMapOf<String, String?>()
    for (f in EmailFrameFields.ALL) {
        val draftValue = draft[f] ?: continue
        val next = normalize(f, draftValue)
        val was = stored[f] ?: ""
        if (next == was) continue
        out[f] = next.ifEmpty { null }
    }
    return out
}

/** The draft's set fields, for the preview. Blank fields are left out so the server renders their default. */
fun emailFramePreviewFrame(draft: Map<String, String>): Map<String, String> =
    EmailFrameFields.ALL.mapNotNull { f ->
        val v = normalize(f, draft[f] ?: "")
        if (v.isEmpty()) null else f to v
    }.toMap()

/** What is wrong with a field, as a sentence, or null. The server applies the same rules and decides. */
fun emailFrameFieldProblem(field: String, value: String): String? {
    val v = value.trim()
    if (v.isEmpty()) return null
    if (field in EmailFrameFields.COLORS) return if (HEX.matches(v)) null else "Use a color like #df8431."
    if (field == EmailFrameFields.HEADER_TEXT || field == EmailFrameFields.FOOTER_TEXT) {
        val max = if (field == EmailFrameFields.HEADER_TEXT) EmailFrameFields.HEADER_TEXT_MAX else EmailFrameFields.FOOTER_TEXT_MAX
        if (v.length > max) return "Keep it to $max characters."
        if (v.contains("{{") || v.contains("}}")) return "Merge fields like {{name}} do not work here."
    }
    return null
}

fun emailFrameProblems(draft: Map<String, String>): Map<String, String> =
    EmailFrameFields.ALL.mapNotNull { f -> emailFrameFieldProblem(f, draft[f] ?: "")?.let { f to it } }.toMap()

/** "#df8431" as an ARGB int for a swatch, or null when the text is not a color yet. */
fun emailFrameColorArgb(hex: String): Long? {
    val v = hex.trim()
    if (!HEX.matches(v)) return null
    return 0xFF000000L or v.substring(1).toLong(16)
}
