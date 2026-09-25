package com.tribetails.auntieos.ui.admin

/**
 * #953 PR 5: one text-field change applied to one block, or refused.
 *
 * The field shows the block's plain text. A change arrives as the whole new
 * text; the diff (common prefix and suffix, widened so it never cuts a
 * surrogate pair) says what was deleted and what was typed. The rules are the
 * spec's "change words, not formatting": no new line breaks, no removed
 * breaks or images, no emptied bold, italic or link, no half-edited merge
 * field, no typed loop or conditional, no emptied block, and no change that
 * would make the block read back as another kind. Tags are never touched, so
 * link and button targets cannot change; a button's words outside its link
 * stay as they are.
 *
 * Only [EmailBlock.TextBlock] is editable. Image and locked blocks (looped
 * lists, block helpers, shapes the phone does not model) have no edit path,
 * and no edit adds, removes or reorders a block.
 */
sealed interface BlockEdit {
    /** [cursor] is where the caret belongs in the new plain text. */
    data class Accepted(val block: EmailBlock.TextBlock, val cursor: Int) : BlockEdit
    data class Rejected(val reason: String) : BlockEdit
}

internal const val EDIT_NO_NEW_LINES = "Line breaks can't be added on the phone."
internal const val EDIT_LOCKED_STRUCTURE = "Line breaks and images stay as they are on the phone."
internal const val EDIT_WHOLE_MERGE_FIELD = "A merge field changes as a whole. Delete all of it or leave it."
internal const val EDIT_KEEP_FORMATTING = "Bold, italic and links can't be removed on the phone. Keep at least one letter."
internal const val EDIT_NOT_EMPTY = "A block can't be emptied on the phone."
internal const val EDIT_NO_WORD_HERE = "Put the cursor next to a word to type."
internal const val EDIT_NO_BLOCK_HELPER = "Loops and conditions can only be added on the web admin."
internal const val EDIT_BUTTON_LABEL_ONLY = "Only the button's words can change."
internal const val EDIT_KEEP_WORDS_BESIDE = "Keep some words beside the button."

private class Leaf(
    val index: Int,
    val start: Int,
    val end: Int,
    val node: EmailInline,
    val formatted: Boolean,
    val inLink: Boolean,
) {
    val text: String get() = (node as? EmailInline.Text)?.text.orEmpty()
}

/** Every non-element node in document order, with its span in the plain text. */
private fun collectLeaves(inlines: List<EmailInline>): List<Leaf> {
    val out = mutableListOf<Leaf>()
    var offset = 0
    fun walk(nodes: List<EmailInline>, formatted: Boolean, inLink: Boolean) {
        for (n in nodes) {
            if (n is EmailInline.Element) {
                walk(n.children, true, inLink || n.name == "a")
                continue
            }
            val length = inlinePlain(n).length
            out += Leaf(out.size, offset, offset + length, n, formatted, inLink)
            offset += length
        }
    }
    walk(inlines, formatted = false, inLink = false)
    return out
}

/** The same tree with text leaves replaced by index (the [collectLeaves] numbering). */
private fun rewriteTexts(inlines: List<EmailInline>, replaced: Map<Int, String>): List<EmailInline> {
    var index = 0
    fun walk(nodes: List<EmailInline>): List<EmailInline> = nodes.map { n ->
        when (n) {
            is EmailInline.Element -> n.copy(children = walk(n.children))
            is EmailInline.Text -> {
                val next = replaced[index++]
                // raw is dropped, so the edited run is written escaped.
                if (next == null || next == n.text) n else EmailInline.Text(next)
            }
            else -> {
                index++
                n
            }
        }
    }
    return walk(inlines)
}

private fun countEmptyElements(nodes: List<EmailInline>): Int {
    var count = 0
    for (n in nodes) {
        if (n !is EmailInline.Element) continue
        if (inlinePlain(n).isEmpty()) count++
        count += countEmptyElements(n.children)
    }
    return count
}

private fun holdsImage(nodes: List<EmailInline>): Boolean =
    nodes.any { it is EmailInline.InlineImage || (it is EmailInline.Element && holdsImage(it.children)) }

/** A `<p>` whose visible content is one button link reads back as a button block (the parser's rule). */
private fun readsAsButton(inlines: List<EmailInline>): Boolean {
    val only = inlines.filterNot { it is EmailInline.Text && it.text.isBlank() }.singleOrNull() as? EmailInline.Element
    return only != null && only.isButton && !holdsImage(only.children)
}

private val P_OPEN_AT_END = Regex("""<p(\s[^>]*)?>$""", RegexOption.IGNORE_CASE)

fun applyBlockEdit(block: EmailBlock.TextBlock, newText: String): BlockEdit {
    val old = block.plainText()
    if (old == newText) return BlockEdit.Accepted(block, newText.length)

    // A block with a helper parses locked, so an editable block holds none; the
    // phone never makes one, not even by typing "{{" beside a "#".
    if (BLOCK_HELPER.containsMatchIn(newText)) return BlockEdit.Rejected(EDIT_NO_BLOCK_HELPER)

    val shortest = minOf(old.length, newText.length)
    var prefix = 0
    while (prefix < shortest && old[prefix] == newText[prefix]) prefix++
    var suffix = 0
    while (suffix < shortest - prefix && old[old.length - 1 - suffix] == newText[newText.length - 1 - suffix]) suffix++
    // Never cut a surrogate pair: an emoji is replaced or kept whole.
    if (prefix > 0 && old[prefix - 1].isHighSurrogate()) prefix--
    if (suffix > 0 && old[old.length - suffix].isLowSurrogate()) suffix--

    var delStart = prefix
    var delEnd = old.length - suffix
    val insert = newText.substring(prefix, newText.length - suffix)
    if (insert.any { it == '\n' || it == '\r' || it == EMAIL_IMAGE_CHAR }) return BlockEdit.Rejected(EDIT_NO_NEW_LINES)

    // Merge fields: nothing typed inside one, nothing typed over part of one,
    // and a deletion that reaches into one takes all of it.
    val tokens = EMAIL_MERGE_TOKEN.findAll(old).map { it.range.first to it.range.last + 1 }.toList()
    var grew = true
    while (grew) {
        grew = false
        for ((ts, te) in tokens) {
            if (delStart == delEnd) {
                if (delStart in ts + 1 until te) return BlockEdit.Rejected(EDIT_WHOLE_MERGE_FIELD)
                continue
            }
            val overlaps = delStart < te && delEnd > ts
            val covers = delStart <= ts && delEnd >= te
            if (overlaps && !covers) {
                if (insert.isNotEmpty()) return BlockEdit.Rejected(EDIT_WHOLE_MERGE_FIELD)
                delStart = minOf(delStart, ts)
                delEnd = maxOf(delEnd, te)
                grew = true
            }
        }
    }

    val leaves = collectLeaves(block.inlines)
    if (leaves.any { it.node !is EmailInline.Text && it.start < delEnd && it.end > delStart }) {
        return BlockEdit.Rejected(EDIT_LOCKED_STRUCTURE)
    }
    val isButton = block.kind == EmailBlockKind.BUTTON
    val texts = leaves.filter { it.node is EmailInline.Text }
    val replaced = HashMap<Int, String>()
    for (leaf in texts) {
        val from = maxOf(leaf.start, delStart)
        val to = minOf(leaf.end, delEnd)
        if (from < to) {
            if (isButton && !leaf.inLink) return BlockEdit.Rejected(EDIT_BUTTON_LABEL_ONLY)
            replaced[leaf.index] = leaf.text.removeRange(from - leaf.start, to - leaf.start)
        }
    }

    if (insert.isNotEmpty()) {
        // A button's words go into its label; nothing is typed beside it.
        val candidates = if (isButton) texts.filter { it.inLink } else texts
        // A run this change emptied gets the new words first (a formatted one
        // before a plain one), so replacing a bold word keeps it bold.
        val emptied = candidates.filter { it.end > it.start && it.start >= delStart && it.end <= delEnd }
        val target = emptied.firstOrNull { it.formatted }
            ?: emptied.firstOrNull()
            ?: candidates.firstOrNull { it.start < delStart && delStart < it.end }
            ?: candidates.firstOrNull { it.end == delStart && !it.inLink }
            ?: candidates.firstOrNull { it.start == delStart }
            ?: candidates.firstOrNull { it.end == delStart }
            ?: return BlockEdit.Rejected(if (isButton) EDIT_BUTTON_LABEL_ONLY else EDIT_NO_WORD_HERE)
        val current = replaced[target.index] ?: target.text
        val at = (delStart - target.start).coerceIn(0, current.length)
        replaced[target.index] = current.substring(0, at) + insert + current.substring(at)
    }

    val inlines = rewriteTexts(block.inlines, replaced)
    if (countEmptyElements(inlines) > countEmptyElements(block.inlines)) return BlockEdit.Rejected(EDIT_KEEP_FORMATTING)
    val updated = block.copy(inlines = inlines)
    // Only images left would read back as an image block, so that counts as empty.
    if (updated.plainText().replace(EMAIL_IMAGE_CHAR.toString(), "").isBlank()) return BlockEdit.Rejected(EDIT_NOT_EMPTY)
    val paragraph = block.kind == EmailBlockKind.PARAGRAPH ||
        (block.kind == EmailBlockKind.CALLOUT && P_OPEN_AT_END.containsMatchIn(block.lead))
    if (paragraph && readsAsButton(inlines)) return BlockEdit.Rejected(EDIT_KEEP_WORDS_BESIDE)
    // A merge field taken whole can leave "{{" beside a "#" the operator never typed.
    if (BLOCK_HELPER.containsMatchIn(updated.plainText())) return BlockEdit.Rejected(EDIT_NO_BLOCK_HELPER)
    return BlockEdit.Accepted(updated, delStart + insert.length)
}
