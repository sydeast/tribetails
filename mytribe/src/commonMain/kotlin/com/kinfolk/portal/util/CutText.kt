package com.kinfolk.portal.util

/**
 * #2323: a cut that never ends on part of a character. `take(n)` counts
 * storage units: an emoji is two, a flag four, and a family emoji is several
 * emoji glued with an invisible joiner. A cut inside one draws a box or a
 * different emoji. The result is never longer than [max] units and ends only
 * between whole characters, the rule the server and the web portal apply with
 * `Intl.Segmenter`.
 *
 * Pure Kotlin on purpose, so a unit test and a phone answer the same way: no
 * platform text library. It refuses to end a cut between the two halves of a
 * surrogate pair, next to an invisible joiner, before a variation selector,
 * keycap mark, combining mark, skin tone or flag tag, inside a pair of flag
 * letters, or between the two halves of a line break. A character longer than
 * the whole budget is dropped, never halved.
 */
fun cutWhole(text: String, max: Int): String {
    if (text.length <= max) return text
    if (max <= 0) return ""
    var end = max
    while (end > 0 && !isCharacterBoundary(text, end)) end--
    return text.substring(0, end)
}

/** The zero width joiner that glues several emoji into one. */
private const val JOINER = '\u200D'

/** Whether a cut before `text[i]` falls between two whole characters. 0 < i < text.length. */
internal fun isCharacterBoundary(text: String, i: Int): Boolean {
    val before = text[i - 1]
    val next = text[i]
    if (before.isHighSurrogate() && next.isLowSurrogate()) return false
    if (before == '\r' && next == '\n') return false
    if (before == JOINER || next == JOINER) return false
    if (isMark(next)) return false
    if (i + 1 < text.length) {
        val low = text[i + 1]
        // Skin tones U+1F3FB..U+1F3FF.
        if (next == '\uD83C' && low in '\uDFFB'..'\uDFFF') return false
        // The tag letters of a subdivision flag U+E0020..U+E007F, and the
        // variation selectors U+E0100..U+E01EF.
        if (next == '\uDB40' && (low in '\uDC20'..'\uDC7F' || low in '\uDD00'..'\uDDEF')) return false
    }
    // Flag letters pair up from the start of their run: a cut after an odd count splits a flag.
    if (isFlagLetter(text, i)) {
        var run = 0
        var j = i - 2
        while (j >= 0 && isFlagLetter(text, j)) {
            run++
            j -= 2
        }
        if (run % 2 == 1) return false
    }
    return true
}

/**
 * Variation selectors (U+FE00..U+FE0F), the keycap mark (U+20E3, in
 * U+20D0..U+20F0) and the combining marks: each belongs to the character
 * before it.
 */
private fun isMark(c: Char): Boolean =
    c in '\uFE00'..'\uFE0F' ||
        c in '\u0300'..'\u036F' ||
        c in '\u1AB0'..'\u1AFF' ||
        c in '\u1DC0'..'\u1DFF' ||
        c in '\u20D0'..'\u20F0' ||
        c in '\uFE20'..'\uFE2F'

/** A regional indicator letter U+1F1E6..U+1F1FF starts at `text[i]`. Two of them make a flag. */
private fun isFlagLetter(text: String, i: Int): Boolean =
    i + 1 < text.length && text[i] == '\uD83C' && text[i + 1] in '\uDDE6'..'\uDDFF'
