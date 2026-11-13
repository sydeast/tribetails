package com.tribetails.auntieos.ui.inbox

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.graphics.Color

/**
 * Renders the fixed rich-text tag subset that the server's `sanitizeRichText()`
 * keeps on kinfolk messages (`b, strong, i, em, u, p, br, ul, ol, li,
 * blockquote, a` with href only, http/https/mailto) into a Compose
 * [AnnotatedString]. Same walker as the portal's `RichTextHtml.kt`, and the
 * same rendering as the admin web's `lib/richText.ts`.
 *
 * Nothing here evaluates markup: only the allowed tags are read as tags (any
 * other `<` is text, drawn as typed), every attribute but `href` is ignored,
 * and an `href` outside the three schemes is dropped. The server
 * sanitizer is the first gate; this is the second.
 */
public fun richTextToAnnotatedString(html: String, linkColor: Color = Color.Unspecified): AnnotatedString {
    if (html.isEmpty()) return AnnotatedString("")
    val nodes = parseRichTextHtml(html)
    val built = buildAnnotatedString {
        val rb = RichTextRenderState(this, linkColor)
        renderNodes(nodes, rb)
    }
    return trimSurroundingNewlines(built)
}

// ---------------------------------------------------------------------------
// Parse tree
// ---------------------------------------------------------------------------

private sealed class RtNode {
    data class Text(val text: String) : RtNode()
    data class Element(val tag: String, val href: String?, val children: List<RtNode>) : RtNode()
}

private sealed class RtToken {
    data class Open(val tag: String, val href: String?) : RtToken()
    data class Close(val tag: String) : RtToken()
    data class Void(val tag: String) : RtToken()
    data class TextChunk(val raw: String) : RtToken()
}

/** Tags with no children/closing tag in this subset. */
private val VOID_TAGS = setOf("br")

private fun parseRichTextHtml(html: String): List<RtNode> {
    val tokens = tokenize(html)
    val root = mutableListOf<RtNode>()
    val stack = ArrayDeque<Pair<String, MutableList<RtNode>>>()

    fun currentChildren(): MutableList<RtNode> = stack.lastOrNull()?.second ?: root

    for (token in tokens) {
        when (token) {
            is RtToken.TextChunk -> {
                val decoded = decodeHtmlEntities(token.raw)
                if (decoded.isNotEmpty()) currentChildren().add(RtNode.Text(decoded))
            }
            is RtToken.Void -> {
                if (token.tag in VOID_TAGS) currentChildren().add(RtNode.Element(token.tag, null, emptyList()))
                // Any other self-closed tag in this subset has no meaningful
                // content by definition (self-closed), nothing to render.
            }
            is RtToken.Open -> {
                val children = mutableListOf<RtNode>()
                currentChildren().add(RtNode.Element(token.tag, token.href, children))
                stack.addLast(token.tag to children)
            }
            is RtToken.Close -> {
                // Best-effort: pop the nearest open tag with this name, or
                // just the top of the stack if the input isn't perfectly
                // balanced. The server-sanitized subset should always be
                // well-formed; this is a safety net, not a security boundary.
                val idx = stack.indexOfLast { it.first == token.tag }
                if (idx >= 0) {
                    while (stack.size > idx) stack.removeLast()
                } else if (stack.isNotEmpty()) {
                    stack.removeLast()
                }
            }
        }
    }
    return root
}

private val TAG_AT = Regex("""^<(/?)([A-Za-z][A-Za-z0-9]*)([^<>]*)>""")
private val QUOTED_ATTRS = Regex("""^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'))*$""")
private val ALLOWED_TAGS = setOf("b", "strong", "i", "em", "u", "p", "br", "ul", "ol", "li", "blockquote", "a")

private class ReadTag(val end: Int, val token: RtToken)

/**
 * Reads the tag that starts at [openIdx], or returns null when that '<' is just
 * a less-than sign. A tag is '<' or '</', one of the allowed tag names, and a
 * closing '>' with no other '<' or '>' in between. The server never stores any
 * other element and keeps no attribute except a quoted one on `a`, so anything
 * else (`5 < 6`, `a <b and more words`, `<script>`) is text and is drawn exactly
 * as typed. Treating every '<' as a tag start and cutting to the next '>' is
 * what dropped words from a message (#1873). Same rule as the admin web parser.
 */
private fun readTag(html: String, openIdx: Int): ReadTag? {
    val m = TAG_AT.find(html.substring(openIdx, minOf(html.length, openIdx + 4096))) ?: return null
    val closing = m.groupValues[1] == "/"
    val name = m.groupValues[2].lowercase()
    val rest = m.groupValues[3]
    if (name !in ALLOWED_TAGS) return null
    val end = openIdx + m.value.length - 1
    if (closing) return if (rest.isBlank()) ReadTag(end, RtToken.Close(name)) else null
    val trimmedRest = rest.trimEnd()
    val selfClosing = trimmedRest.endsWith("/")
    val attrs = if (selfClosing) trimmedRest.dropLast(1) else rest
    if (selfClosing && name != "br") return null
    if (attrs.isNotBlank() && !(name == "a" && QUOTED_ATTRS.matches(attrs.trimEnd()))) return null
    if (name == "br") return ReadTag(end, RtToken.Void("br"))
    return ReadTag(end, RtToken.Open(name, if (name == "a") extractHref(attrs) else null))
}

private fun tokenize(html: String): List<RtToken> {
    val tokens = mutableListOf<RtToken>()
    var textStart = 0
    var i = 0
    val n = html.length
    while (i < n) {
        if (html[i] == '<') {
            val tag = readTag(html, i)
            if (tag != null) {
                if (i > textStart) tokens.add(RtToken.TextChunk(html.substring(textStart, i)))
                tokens.add(tag.token)
                i = tag.end + 1
                textStart = i
                continue
            }
        }
        i++
    }
    if (textStart < n) tokens.add(RtToken.TextChunk(html.substring(textStart)))
    return tokens
}

private val HREF_DOUBLE_QUOTED = Regex("""href\s*=\s*"([^"]*)"""")
private val HREF_SINGLE_QUOTED = Regex("""href\s*=\s*'([^']*)'""")

/**
 * Defense-in-depth: mirrors the server's own scheme allowlist
 * (`allowedSchemes: ['http', 'https', 'mailto']` in
 * functions/src/lib/richText.ts's `sanitizeRichText`). The server already
 * strips any other scheme before this string is ever persisted, so this
 * should never trigger in practice, it's a second gate in case that
 * guarantee ever weakens or a future call site feeds this renderer
 * less-trusted input.
 */
private val ALLOWED_HREF_SCHEMES = listOf("http://", "https://", "mailto:")

private fun extractHref(tagBody: String): String? {
    val match = HREF_DOUBLE_QUOTED.find(tagBody) ?: HREF_SINGLE_QUOTED.find(tagBody)
    val href = match?.groupValues?.get(1)?.let { decodeHtmlEntities(it) } ?: return null
    val lower = href.trim().lowercase()
    return if (ALLOWED_HREF_SCHEMES.any { lower.startsWith(it) }) href else null
}

/**
 * Mirrors `decodeEntities` in `functions/src/lib/richText.ts` exactly,
 * including the ordering (`&amp;` decoded last, so `"&amp;lt;"` correctly
 * becomes the literal text `"&lt;"` rather than a resurrected `<`).
 */
private fun decodeHtmlEntities(s: String): String {
    if ('&' !in s) return s
    return s
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

private class ListContext(val ordered: Boolean) {
    var counter: Int = 0
}

/**
 * Tracks render state across the recursive walk. Line-start decoration
 * (blockquote "▍ " markers, list-item bullets/numbers) is applied lazily -
 * only when real content is about to be written, so a block element that's
 * the first thing inside an `<li>` or `<blockquote>` doesn't wrongly trigger
 * an extra blank line before it.
 */
private class RichTextRenderState(val builder: androidx.compose.ui.text.AnnotatedString.Builder, val linkColor: Color) {
    /** True when nothing has been written on the current output line yet. */
    var atLineStart: Boolean = true
    var blockquoteDepth: Int = 0
    var pendingListMarker: String? = null
    val listStack = ArrayDeque<ListContext>()

    /** Writes literal newline unconditionally (used by explicit `<br>`). */
    fun hardNewline() {
        builder.append("\n")
        atLineStart = true
        pendingListMarker = null
    }

    /**
     * Ensures a block-level element (p, ul, ol, li, blockquote) starts on a
     * fresh line, collapsing so adjacent block elements get exactly one
     * newline between them rather than doubling up.
     */
    fun startBlock() {
        if (!atLineStart) hardNewline()
    }

    /** Appends real user-visible text, flushing any pending line decoration first. */
    fun appendText(text: String) {
        if (text.isEmpty()) return
        // A run of user text may itself contain literal newlines (e.g. pasted
        // text), each one needs the same line-start decoration treatment as
        // an explicit <br>.
        val parts = text.split("\n")
        parts.forEachIndexed { index, part ->
            if (index > 0) hardNewline()
            if (part.isNotEmpty()) {
                flushLineDecorationIfNeeded()
                builder.append(part)
                atLineStart = false
            }
        }
    }

    private fun flushLineDecorationIfNeeded() {
        if (!atLineStart) return
        if (blockquoteDepth > 0) builder.append("▍ ".repeat(blockquoteDepth))
        pendingListMarker?.let {
            builder.append(it)
            pendingListMarker = null
        }
    }
}

private fun renderNodes(nodes: List<RtNode>, rb: RichTextRenderState) {
    for (node in nodes) {
        when (node) {
            is RtNode.Text -> rb.appendText(node.text)
            is RtNode.Element -> renderElement(node, rb)
        }
    }
}

private fun renderElement(el: RtNode.Element, rb: RichTextRenderState) {
    when (el.tag) {
        "b", "strong" -> withSpan(rb, SpanStyle(fontWeight = FontWeight.Bold)) { renderNodes(el.children, rb) }
        "i", "em" -> withSpan(rb, SpanStyle(fontStyle = FontStyle.Italic)) { renderNodes(el.children, rb) }
        "u" -> withSpan(rb, SpanStyle(textDecoration = TextDecoration.Underline)) { renderNodes(el.children, rb) }
        "br" -> rb.hardNewline()
        "p" -> {
            rb.startBlock()
            renderNodes(el.children, rb)
        }
        "blockquote" -> {
            rb.startBlock()
            rb.blockquoteDepth++
            renderNodes(el.children, rb)
            rb.blockquoteDepth--
        }
        "ul", "ol" -> {
            rb.startBlock()
            rb.listStack.addLast(ListContext(ordered = el.tag == "ol"))
            renderNodes(el.children, rb)
            rb.listStack.removeLast()
        }
        "li" -> {
            rb.startBlock()
            val ctx = rb.listStack.lastOrNull()
            rb.pendingListMarker = if (ctx != null && ctx.ordered) {
                ctx.counter++
                "${ctx.counter}. "
            } else {
                "• "
            }
            renderNodes(el.children, rb)
        }
        "a" -> {
            val href = el.href
            if (href.isNullOrBlank()) {
                renderNodes(el.children, rb)
            } else {
                val linkStyle = SpanStyle(color = rb.linkColor, textDecoration = TextDecoration.Underline)
                val linkIndex = rb.builder.pushLink(LinkAnnotation.Url(href, TextLinkStyles(style = linkStyle)))
                renderNodes(el.children, rb)
                rb.builder.pop(linkIndex)
            }
        }
        else -> {
            // Not part of the allowed tag subset: unwrap, keep its text.
            renderNodes(el.children, rb)
        }
    }
}

private inline fun withSpan(rb: RichTextRenderState, style: SpanStyle, body: () -> Unit) {
    val index = rb.builder.pushStyle(style)
    body()
    rb.builder.pop(index)
}

private fun trimSurroundingNewlines(text: AnnotatedString): AnnotatedString {
    var start = 0
    while (start < text.length && text[start] == '\n') start++
    var end = text.length
    while (end > start && text[end - 1] == '\n') end--
    return if (start == 0 && end == text.length) text else text.subSequence(start, end)
}

/** True when the body carries a real tag. A plain-text reply has none and is shown as typed. */
public fun hasRichTextMarkup(body: String): Boolean {
    var i = body.indexOf('<')
    while (i != -1) {
        if (readTag(body, i) != null) return true
        i = body.indexOf('<', i + 1)
    }
    return false
}
/** The text of a stored message body with every tag removed, for tests and previews. */
public fun richTextPlain(body: String): String = richTextToAnnotatedString(body).text

/**
 * The text of a tag-less stored body, as typed: the server stores every typed
 * `&`, `<` and `>` as an entity, decoded here exactly once.
 */
public fun messageBodyText(body: String): String = decodeHtmlEntities(body)
/**
 * Plain typed text as a message body for the server: `&`, `<` and `>` as
 * entities, so a typed `&lt;` or `<side gate>` is stored and shown as typed.
 * Same rule as the server's `plainTextToMessageBody` (functions/src/lib/richText.ts).
 */
public fun plainTextToMessageBody(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
