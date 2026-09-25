package com.tribetails.auntieos.ui.admin

/**
 * #953 PR 5: a visual email body as blocks the phone can edit, and back to HTML.
 *
 * Pure Kotlin with no Android types, so the JVM suite proves the round trip.
 * The input is what the server's sanitizer (`mytribe/functions/src/lib/emailContent.ts`)
 * stored. Every character of it is kept: markup the phone never edits (tags,
 * attributes, whitespace between blocks) rides along as its source text, and a
 * shape the phone does not model becomes a [EmailBlock.LockedBlock] holding its
 * source. So `serializeEmailContent(parseEmailContent(x)) == x` for any string,
 * and a save with no edits writes back exactly what it read.
 *
 * The stored void elements are `<br>` and `<img …>`: the sanitizer rewrites
 * sanitize-html's `<br />` and `<img … />`, and all 52 seeds are spelled that
 * way. Tags are kept as written, so either spelling round-trips.
 *
 * A text block holding a block helper (`{{#…}}`, `{{/…}}`, `{{^…}}`, `{{else}}`)
 * is locked, like a looped list: deleting part of a helper would break the
 * template, so those blocks are edited on the web admin only.
 *
 * The Compose rich-text library the spec named was not used: its HTML export
 * writes <b>/<i>, adds target="_blank", drops class and alt, and splits a
 * paragraph at every <br>, so it could not give this guarantee.
 */

/** The server's merge-token shape (`MERGE_TOKEN` in emailContent.ts). */
val EMAIL_MERGE_TOKEN = Regex("""\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}""")

/** Stands in for an inline image in a block's plain text: one UTF-16 unit, so offsets stay simple. */
const val EMAIL_IMAGE_CHAR = '￼'

sealed interface EmailInline {
    /** Text. [raw] is its source spelling, kept until the text is edited, so an untouched run is written back as found. */
    data class Text(val text: String, val raw: String? = null) : EmailInline

    /** A line break, spelled as found (`<br>`, as stored). The phone never adds or removes one. */
    data class Break(val raw: String) : EmailInline

    /** An `<img>` inside text. Locked. */
    data class InlineImage(val raw: String) : EmailInline

    /** `strong`, `em` or `a`. Both tags are kept verbatim, so a link target and a button class cannot change. */
    data class Element(
        val name: String,
        val openTag: String,
        val children: List<EmailInline>,
        val closeTag: String,
    ) : EmailInline
}

val EmailInline.Element.href: String? get() = htmlAttribute(openTag, "href")
val EmailInline.Element.isButton: Boolean get() = name == "a" && htmlAttribute(openTag, "class") == "button"

enum class EmailBlockKind { PARAGRAPH, HEADING2, HEADING3, BULLET_ITEM, NUMBERED_ITEM, CALLOUT, BUTTON }

sealed interface EmailBlock {
    /** Source markup written before the block's own content: its tag, a list or callout wrapper, whitespace. */
    val lead: String

    /** Source markup written after it. */
    val trail: String

    data class TextBlock(
        val kind: EmailBlockKind,
        val inlines: List<EmailInline>,
        override val lead: String,
        override val trail: String,
        /** 1-based position in a numbered list, else null. */
        val number: Int? = null,
    ) : EmailBlock

    /** A paragraph holding only an image, or a bare `<img>` between blocks. Shown, never edited. */
    data class ImageBlock(val raw: String, override val lead: String, override val trail: String) : EmailBlock

    /** A shape the phone does not edit: a nested list, an empty paragraph, stray text, a block helper. Written back as found. */
    data class LockedBlock(val raw: String, override val lead: String = "", override val trail: String = "") : EmailBlock
}

val EmailBlock.ImageBlock.src: String get() = htmlAttribute(raw, "src").orEmpty()
val EmailBlock.ImageBlock.alt: String get() = htmlAttribute(raw, "alt").orEmpty()

// ── plain text ────────────────────────────────────────────────────────────────

fun inlinePlain(n: EmailInline): String = when (n) {
    is EmailInline.Text -> n.text
    is EmailInline.Break -> "\n"
    is EmailInline.InlineImage -> EMAIL_IMAGE_CHAR.toString()
    is EmailInline.Element -> n.children.joinToString("") { inlinePlain(it) }
}

fun EmailBlock.TextBlock.plainText(): String = inlines.joinToString("") { inlinePlain(it) }

/** The locked target of the button in [block], or null when it holds none. */
fun buttonTarget(block: EmailBlock.TextBlock): String? {
    fun find(nodes: List<EmailInline>): EmailInline.Element? {
        for (n in nodes) {
            if (n !is EmailInline.Element) continue
            if (n.isButton) return n
            find(n.children)?.let { return it }
        }
        return null
    }
    return find(block.inlines)?.href
}

/** True when [text] holds `{{` or `}}` that is not part of a whole merge field. */
fun hasBrokenMergeField(text: String): Boolean {
    val rest = EMAIL_MERGE_TOKEN.replace(text, "")
    return "{{" in rest || "}}" in rest
}

/** Readable text for a fragment: tags dropped, entities decoded, one line per block. */
fun htmlToReadableText(html: String): String =
    decodeHtmlEntities(
        html.replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("</(p|h2|h3|li|blockquote)>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]*>"), ""),
    ).lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n")

// ── entities and attributes ───────────────────────────────────────────────────

private val ENTITY = Regex("&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);")

fun decodeHtmlEntities(s: String): String {
    if ('&' !in s) return s
    return ENTITY.replace(s) { m ->
        val e = m.groupValues[1]
        val code = when {
            e.startsWith("#x") || e.startsWith("#X") -> e.drop(2).toIntOrNull(16)
            e.startsWith("#") -> e.drop(1).toIntOrNull()
            else -> null
        }
        when {
            code != null -> if (Character.isValidCodePoint(code)) String(Character.toChars(code)) else m.value
            e == "amp" -> "&"
            e == "lt" -> "<"
            e == "gt" -> ">"
            e == "quot" -> "\""
            e == "apos" -> "'"
            e == "nbsp" -> " "
            else -> m.value
        }
    }
}

/** How the sanitizer escapes text: `&`, `<`, `>` only. Used for an edited run. */
fun escapeHtmlText(s: String): String = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/** The decoded value of attribute [name] in one start tag, or null when absent. */
fun htmlAttribute(tag: String, name: String): String? {
    val m = Regex(
        """\s${Regex.escape(name)}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
        RegexOption.IGNORE_CASE,
    ).find(tag) ?: return null
    val value = m.groups[1]?.value ?: m.groups[2]?.value ?: m.groups[3]?.value ?: ""
    return decodeHtmlEntities(value)
}

// ── serialize ─────────────────────────────────────────────────────────────────

fun serializeEmailContent(blocks: List<EmailBlock>): String = buildString {
    for (b in blocks) {
        append(b.lead)
        when (b) {
            is EmailBlock.TextBlock -> b.inlines.forEach { appendInline(it) }
            is EmailBlock.ImageBlock -> append(b.raw)
            is EmailBlock.LockedBlock -> append(b.raw)
        }
        append(b.trail)
    }
}

private fun StringBuilder.appendInline(n: EmailInline) {
    when (n) {
        is EmailInline.Text -> append(n.raw ?: escapeHtmlText(n.text))
        is EmailInline.Break -> append(n.raw)
        is EmailInline.InlineImage -> append(n.raw)
        is EmailInline.Element -> {
            append(n.openTag)
            n.children.forEach { appendInline(it) }
            append(n.closeTag)
        }
    }
}

// ── tokenize into a source-offset tree ────────────────────────────────────────

/**
 * One node of the source, by offsets. [name] is null for text and "" for an end
 * tag that closes nothing. Children cover [openEnd, closeStart) exactly, so
 * every character belongs to one node.
 */
private class Node(val name: String?, val start: Int, val openEnd: Int) {
    var closeStart: Int = openEnd
    var end: Int = openEnd
    val children = mutableListOf<Node>()
    fun close(closeStart: Int, end: Int) {
        this.closeStart = closeStart
        this.end = end
    }
}

private val VOID_TAGS = setOf("br", "img", "hr", "wbr")

private fun String.rawOf(n: Node) = substring(n.start, n.end)
private fun String.openOf(n: Node) = substring(n.start, n.openEnd)
private fun String.closeOf(n: Node) = substring(n.closeStart, n.end)

/** Index just past the `>` of a tag starting at [lt], or -1 when this `<` is text. */
private fun tagEndAt(html: String, lt: Int): Int {
    if (lt + 1 >= html.length) return -1
    val next = html[lt + 1]
    val isTag = next.isLetter() || (next == '/' && lt + 2 < html.length && html[lt + 2].isLetter())
    if (!isTag) return -1
    var j = lt + 1
    var quote: Char? = null
    while (j < html.length) {
        val ch = html[j]
        if (quote != null) {
            if (ch == quote) quote = null
        } else if (ch == '"' || ch == '\'') {
            quote = ch
        } else if (ch == '>') {
            return j + 1
        }
        j++
    }
    return -1
}

private fun tagNameOf(html: String, lt: Int): String {
    var j = lt + 1
    while (j < html.length && html[j].isLetterOrDigit()) j++
    return html.substring(lt + 1, j).lowercase()
}

private fun parseNodes(html: String): List<Node> {
    val root = mutableListOf<Node>()
    val open = ArrayDeque<Node>()
    fun sink(): MutableList<Node> = open.lastOrNull()?.children ?: root
    var textStart = -1
    fun flushText(upTo: Int) {
        if (textStart in 0 until upTo) sink().add(Node(null, textStart, upTo))
        textStart = -1
    }
    var i = 0
    while (i < html.length) {
        val tagEnd = if (html[i] == '<') tagEndAt(html, i) else -1
        if (tagEnd < 0) {
            if (textStart < 0) textStart = i
            i++
            continue
        }
        flushText(i)
        if (html[i + 1] == '/') {
            val name = html.substring(i + 2, tagEnd - 1).trim().lowercase()
            val depth = open.indexOfLast { it.name == name }
            if (depth < 0) {
                sink().add(Node("", i, tagEnd))
            } else {
                // Elements left open inside it end here, with no close tag of their own.
                while (open.size - 1 > depth) open.removeLast().close(i, i)
                open.removeLast().close(i, tagEnd)
            }
        } else {
            val name = tagNameOf(html, i)
            val node = Node(name, i, tagEnd)
            sink().add(node)
            if (name in VOID_TAGS || html[tagEnd - 2] == '/') node.close(tagEnd, tagEnd) else open.addLast(node)
        }
        i = tagEnd
    }
    flushText(html.length)
    while (open.isNotEmpty()) open.removeLast().close(html.length, html.length)
    return root
}

// ── classify into blocks ──────────────────────────────────────────────────────

private val INLINE_ELEMENTS = setOf("strong", "em", "a")

private fun inlineOf(html: String, n: Node): EmailInline? {
    val raw = html.rawOf(n)
    val name = n.name ?: return EmailInline.Text(decodeHtmlEntities(raw), raw)
    return when {
        name == "br" -> EmailInline.Break(raw)
        name == "img" -> EmailInline.InlineImage(raw)
        name in INLINE_ELEMENTS -> {
            val kids = inlinesOf(html, n.children) ?: return null
            EmailInline.Element(name, html.openOf(n), kids, html.closeOf(n))
        }
        else -> null
    }
}

/** The nodes as inline content, or null when any of them is a block or a stray tag. */
private fun inlinesOf(html: String, nodes: List<Node>): List<EmailInline>? {
    val out = ArrayList<EmailInline>(nodes.size)
    for (n in nodes) out += inlineOf(html, n) ?: return null
    return out
}

/** `{{#…}}`, `{{/…}}`, `{{^…}}` or `{{else}}`: a loop or conditional, which the phone never edits. */
internal val BLOCK_HELPER = Regex("""\{\{\s*[#/^]|\{\{\s*else\b""")

/**
 * The nodes as the inlines of an editable text block, or null when the block
 * must be locked: a block or stray tag inside, no content, or a block helper
 * in its text.
 */
private fun editableInlinesOf(html: String, nodes: List<Node>): List<EmailInline>? {
    val inlines = inlinesOf(html, nodes)?.takeIf { it.isNotEmpty() } ?: return null
    if (BLOCK_HELPER.containsMatchIn(inlines.joinToString("") { inlinePlain(it) })) return null
    return inlines
}

private fun containsImage(nodes: List<EmailInline>): Boolean =
    nodes.any { it is EmailInline.InlineImage || (it is EmailInline.Element && containsImage(it.children)) }

private fun EmailBlock.withLead(lead: String): EmailBlock = when (this) {
    is EmailBlock.TextBlock -> copy(lead = lead)
    is EmailBlock.ImageBlock -> copy(lead = lead)
    is EmailBlock.LockedBlock -> copy(lead = lead)
}

private fun EmailBlock.withTrail(trail: String): EmailBlock = when (this) {
    is EmailBlock.TextBlock -> copy(trail = trail)
    is EmailBlock.ImageBlock -> copy(trail = trail)
    is EmailBlock.LockedBlock -> copy(trail = trail)
}

private fun MutableList<EmailBlock>.appendToLastTrail(s: String) {
    this[lastIndex] = last().let { it.withTrail(it.trail + s) }
}

private fun paragraphOf(html: String, p: Node, kind: EmailBlockKind, lead: String, trail: String): EmailBlock? {
    val inlines = editableInlinesOf(html, p.children) ?: return null
    val single = inlines.singleOrNull()
    if (single is EmailInline.InlineImage) return EmailBlock.ImageBlock(single.raw, lead, trail)
    val visible = inlines.filterNot { it is EmailInline.Text && it.text.isBlank() }
    val only = visible.singleOrNull() as? EmailInline.Element
    val isButton = only != null && only.isButton && !containsImage(only.children)
    return EmailBlock.TextBlock(if (isButton) EmailBlockKind.BUTTON else kind, inlines, lead, trail)
}

private fun headingOf(html: String, h: Node, kind: EmailBlockKind): List<EmailBlock>? {
    val inlines = editableInlinesOf(html, h.children) ?: return null
    return listOf(EmailBlock.TextBlock(kind, inlines, html.openOf(h), html.closeOf(h)))
}

private fun listItemsOf(html: String, list: Node, kind: EmailBlockKind): List<EmailBlock>? {
    val items = mutableListOf<EmailBlock>()
    val lead = StringBuilder(html.openOf(list))
    for (child in list.children) {
        val raw = html.rawOf(child)
        if (child.name == null && raw.isBlank()) {
            if (items.isEmpty()) lead.append(raw) else items.appendToLastTrail(raw)
            continue
        }
        if (child.name != "li") return null
        val number = if (kind == EmailBlockKind.NUMBERED_ITEM) items.size + 1 else null
        // TipTap writes <li><p>item</p></li>; the sanitizer keeps it.
        val onlyP = child.children.singleOrNull()?.takeIf { it.name == "p" }
        val item = if (onlyP != null) {
            val inlines = editableInlinesOf(html, onlyP.children) ?: return null
            EmailBlock.TextBlock(
                kind, inlines,
                lead.toString() + html.openOf(child) + html.openOf(onlyP),
                html.closeOf(onlyP) + html.closeOf(child),
                number,
            )
        } else {
            val inlines = editableInlinesOf(html, child.children) ?: return null
            EmailBlock.TextBlock(kind, inlines, lead.toString() + html.openOf(child), html.closeOf(child), number)
        }
        items += item
        lead.setLength(0)
    }
    if (items.isEmpty()) return null
    items.appendToLastTrail(html.closeOf(list))
    return items
}

private fun calloutOf(html: String, quote: Node): List<EmailBlock>? {
    val kids = quote.children
    val allParagraphs = kids.any { it.name == "p" } &&
        kids.all { it.name == "p" || (it.name == null && html.rawOf(it).isBlank()) }
    if (!allParagraphs) {
        val inlines = editableInlinesOf(html, kids) ?: return null
        return listOf(EmailBlock.TextBlock(EmailBlockKind.CALLOUT, inlines, html.openOf(quote), html.closeOf(quote)))
    }
    val blocks = mutableListOf<EmailBlock>()
    val lead = StringBuilder(html.openOf(quote))
    for (child in kids) {
        val raw = html.rawOf(child)
        if (child.name == null) {
            if (blocks.isEmpty()) lead.append(raw) else blocks.appendToLastTrail(raw)
            continue
        }
        blocks += paragraphOf(html, child, EmailBlockKind.CALLOUT, lead.toString() + html.openOf(child), html.closeOf(child))
            ?: return null
        lead.setLength(0)
    }
    blocks.appendToLastTrail(html.closeOf(quote))
    return blocks
}

private fun blocksOf(html: String, n: Node): List<EmailBlock>? = when (n.name) {
    "p" -> paragraphOf(html, n, EmailBlockKind.PARAGRAPH, html.openOf(n), html.closeOf(n))?.let { listOf(it) }
    "h2" -> headingOf(html, n, EmailBlockKind.HEADING2)
    "h3" -> headingOf(html, n, EmailBlockKind.HEADING3)
    "img" -> listOf(EmailBlock.ImageBlock(html.rawOf(n), "", ""))
    "ul" -> listItemsOf(html, n, EmailBlockKind.BULLET_ITEM)
    "ol" -> listItemsOf(html, n, EmailBlockKind.NUMBERED_ITEM)
    "blockquote" -> calloutOf(html, n)
    else -> null
}

fun parseEmailContent(html: String): List<EmailBlock> {
    val out = mutableListOf<EmailBlock>()
    val pending = StringBuilder()
    fun add(block: EmailBlock) {
        out += if (pending.isEmpty()) block else block.withLead(pending.toString() + block.lead)
        pending.setLength(0)
    }
    for (n in parseNodes(html)) {
        val raw = html.rawOf(n)
        if (n.name == null && raw.isBlank()) {
            if (out.isEmpty()) pending.append(raw) else out.appendToLastTrail(raw)
            continue
        }
        val blocks = blocksOf(html, n)
        if (blocks == null) add(EmailBlock.LockedBlock(raw)) else blocks.forEach { add(it) }
    }
    if (pending.isNotEmpty()) out += EmailBlock.LockedBlock(pending.toString())
    return out
}
