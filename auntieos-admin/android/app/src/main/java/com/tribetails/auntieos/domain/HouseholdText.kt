package com.tribetails.auntieos.domain

/**
 * #2408, operator ruling 2026-11-14: a household's text message stays short and
 * links to the full message in MyTribe. An approved Text draft is texted as a
 * short line followed by "More in MyTribe:" and a link to the message's own
 * entry on the household's notifications list, where it reads whole.
 *
 * This is what the composer shows for a Text, so the operator approves the text
 * the household will get and not the draft it was cut from. The same rule as
 * the server's `householdSms` (`notifications/templateParsers.ts`), which is
 * the one that decides what is sent, and as the web admin's
 * `lib/householdText.ts`.
 */
/** Where MyTribe lives. The server's `PORTAL_URL`. */
internal const val MYTRIBE_URL = "https://kinfolk.tribetails.com"
/** The longest message a household text carries before it is cut. */
internal const val HOUSEHOLD_TEXT_LINE_MAX = 200
/** What comes before the link. */
internal const val HOUSEHOLD_TEXT_LINK_LABEL = "More in MyTribe:"
/** The longest unfinished word the cut steps back over. */
private const val WORD_BACKOFF = 30
/** Every run of spaces and line breaks the server folds to one space. */
private val SPACES = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
private val ADDRESS = Regex("://|^www\\.", RegexOption.IGNORE_CASE)
internal data class HouseholdTextPreview(
    /** The message as texted, before the link. */
    val line: String,
    /** The message was longer than the short line, so the rest is only in MyTribe. */
    val cut: Boolean,
    /** "More in MyTribe:" and a link follow the line. False when the message carries its own MyTribe link and fits. */
    val linkAdded: Boolean,
)
/** [text] cut to at most [max] at the end of a word. A web address the cut landed inside is dropped whole. */
private fun cutAtWord(text: String, max: Int): String {
    val head = cutWhole(text, max)
    if (head.length == text.length || text[head.length] == ' ') return head.trimEnd()
    val lastSpace = head.lastIndexOf(' ')
    if (lastSpace <= 0) return head
    val unfinished = head.substring(lastSpace + 1)
    val isAddress = ADDRESS.containsMatchIn(unfinished)
    return if (isAddress || unfinished.length <= WORD_BACKOFF) head.substring(0, lastSpace).trimEnd() else head
}
/** The text a household is sent for these words. Pure. */
internal fun householdTextPreview(body: String): HouseholdTextPreview {
    val flat = body.replace(SPACES, " ").trim()
    if (flat.isEmpty()) return HouseholdTextPreview(line = "", cut = false, linkAdded = false)
    val longest = HOUSEHOLD_TEXT_LINE_MAX + 1 + "$HOUSEHOLD_TEXT_LINK_LABEL $MYTRIBE_URL/notifications".length
    if (flat.contains(MYTRIBE_URL) && flat.length <= longest) {
        return HouseholdTextPreview(line = flat, cut = false, linkAdded = false)
    }
    val words = flat.split(' ').filter { !it.contains(MYTRIBE_URL) }.joinToString(" ")
    val cut = words.length > HOUSEHOLD_TEXT_LINE_MAX
    return HouseholdTextPreview(
        line = if (cut) cutAtWord(words, HOUSEHOLD_TEXT_LINE_MAX - 3) + "..." else words,
        cut = cut,
        linkAdded = true,
    )
}
/** The preview as one line: the text, then where its link goes. Pure. */
internal fun householdTextPreviewLine(body: String): String {
    val p = householdTextPreview(body)
    return if (p.linkAdded) "${p.line} $HOUSEHOLD_TEXT_LINK_LABEL (link)" else p.line
}
