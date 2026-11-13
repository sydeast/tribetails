package com.kinfolk.portal.util

/** First (featured) KinTales card on web: `tale.body.slice(0, 90)`. */
const val KIN_TALE_HEADLINE_FEATURED_CHARS = 90

/** Every other KinTales card on web: `tale.body.slice(0, 70)`. */
const val KIN_TALE_HEADLINE_CARD_CHARS = 70

/** Home's Recent KinTales row on web: `t.body.slice(0, 60)`. */
const val KIN_TALE_HEADLINE_HOME_CHARS = 60

private val WHITESPACE_RUN = Regex("\\s+")

/**
 * A KinTale's headline as the web portal shows it (#2166): the Auntie's own
 * title, whole, or the opening [fallbackChars] characters of the body when
 * there is none (an older tale written before titles existed). No ellipsis
 * is added to the cut, matching web's `title || body.slice(0, n)`.
 *
 * Whitespace runs collapse to one space and the ends are trimmed, which is
 * how the browser lays the same text out; without that, a newline inside the
 * body's opening would break the headline across lines on Android only. A
 * title that is only whitespace counts as no title. Returns null when there
 * is nothing to show, so the card draws no empty headline line.
 */
fun kinTaleHeadline(title: String?, body: String, fallbackChars: Int): String? {
    val ownTitle = title?.normalizeHeadline()?.takeIf { it.isNotEmpty() }
    if (ownTitle != null) return ownTitle
    var cut = body.take(fallbackChars)
    // Never end on half of an emoji's surrogate pair.
    if (cut.length == fallbackChars && cut.lastOrNull()?.isHighSurrogate() == true) cut = cut.dropLast(1)
    return cut.normalizeHeadline().takeIf { it.isNotEmpty() }
}

private fun String.normalizeHeadline(): String = replace(WHITESPACE_RUN, " ").trim()

/**
 * The byline under a KinTale headline, as both web surfaces write it:
 * "FROM AUNTIE AVERY · 2D AGO". A migrated tale with no readable date shows
 * its stored text as written (#1775); no date at all leaves the separator off.
 */
fun kinTaleByline(authorDisplayName: String?, sentAtMs: Long?, sentAtText: String?): String = buildString {
    append("FROM ")
    append((auntieName(authorDisplayName) ?: "YOUR AUNTIE").uppercase())
    if (sentAtMs != null) {
        append(" · ")
        append(relativeTime(sentAtMs).uppercase())
    } else {
        sentAtText?.trim()?.takeIf { it.isNotEmpty() }?.let {
            append(" · ")
            append(it)
        }
    }
}
