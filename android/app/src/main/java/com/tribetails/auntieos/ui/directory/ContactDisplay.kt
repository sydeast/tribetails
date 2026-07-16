package com.tribetails.auntieos.ui.directory

/** Contact channels we recognize in a (possibly messy) preferredContactMethod string.
 *  Order is the display order; none is a substring of another so matching stays clean. */
private val CONTACT_CHANNELS = listOf("Email", "Text", "SMS", "Phone", "Call", "Push")

/**
 * Clean a preferredContactMethod value for one-line display.
 *
 * The field is meant to hold a short channel ("Text" / "Email"), but legacy and demo rows
 * concatenated notification "Channel: category" preferences with no separator, e.g. Run 4's
 * "Email: Pet Care Journals & CommentsEmail: Important Business Updates". With no delimiter we
 * cannot reliably re-split it, so we surface the DISTINCT channels mentioned. If none are
 * recognized we collapse whitespace and truncate, so the line never runs long.
 *
 * Real data ("Text", "Email") passes through unchanged. Mirrors the web helper of the same name.
 */
fun preferredContactSummary(raw: String): String {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return ""
    val channels = CONTACT_CHANNELS.filter { trimmed.contains(it, ignoreCase = true) }
    if (channels.isNotEmpty()) return channels.joinToString(", ")
    val collapsed = trimmed.replace(Regex("\\s+"), " ")
    return if (collapsed.length <= 40) collapsed else collapsed.take(39).trimEnd() + "…"
}
