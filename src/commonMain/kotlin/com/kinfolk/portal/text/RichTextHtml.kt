package com.kinfolk.portal.text

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import com.kinfolk.portal.theme.KinfolkBrand

/**
 * Renders the fixed rich-text tag subset that `functions/src/lib/richText.ts`'s
 * `sanitizeRichText()` guarantees server-side (`b, strong, i, em, u, p, br, ul,
 * ol, li, blockquote, a` — href only, http/https/mailto) into a Compose
 * [AnnotatedString].
 *
 * This is a rendering convenience, not a security boundary: the string has
 * already been through `sanitizeRichText()` before it ever reaches a client,
 * so this parser doesn't defend against arbitrary/malicious markup — it just
 * needs to not crash on well-formed input from that exact tag subset. No
 * third-party HTML/XML dependency: the tag subset is tiny and fixed, so a
 * small hand-rolled walker is the right amount of engineering here.
 *
 * Mirrors the web portal's rendering of the same field
 * (`web/src/screens/Messages.tsx`'s `MessageBubble`, which trusts the
 * sanitized HTML and sets it via `dangerouslySetInnerHTML`) so all platforms
 * show the same bold/italic/underline/lists/links instead of literal tags.
 */
public fun richTextToAnnotatedString(html: String): AnnotatedString {
    if (html.isEmpty()) return AnnotatedString("")
    val nodes = parseRichTextHtml(html)
    val built = buildAnnotatedString {
        val rb = RichTextRenderState(this)
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
                // content by definition (self-closed) — nothing to render.
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

private fun tokenize(html: String): List<RtToken> {
    val tokens = mutableListOf<RtToken>()
    var i = 0
    val n = html.length
    while (i < n) {
        if (html[i] == '<') {
            val end = findTagEnd(html, i)
            if (end == -1) {
                tokens.add(RtToken.TextChunk(html.substring(i)))
                break
            }
            val inner = html.substring(i + 1, end)
            tokens.add(parseTagToken(inner))
            i = end + 1
        } else {
            val next = html.indexOf('<', i)
            val textEnd = if (next == -1) n else next
            tokens.add(RtToken.TextChunk(html.substring(i, textEnd)))
            i = textEnd
        }
    }
    return tokens
}

/** Finds the index of the '>' that closes the tag starting at [openIdx], skipping quoted attribute values. */
private fun findTagEnd(html: String, openIdx: Int): Int {
    var i = openIdx + 1
    var quote: Char? = null
    while (i < html.length) {
        val c = html[i]
        if (quote != null) {
            if (c == quote) quote = null
        } else if (c == '"' || c == '\'') {
            quote = c
        } else if (c == '>') {
            return i
        }
        i++
    }
    return -1
}

private fun parseTagToken(inner: String): RtToken {
    val trimmed = inner.trim()
    if (trimmed.startsWith("/")) {
        return RtToken.Close(trimmed.substring(1).trim().lowercase())
    }
    val selfClosing = trimmed.endsWith("/")
    val body = if (selfClosing) trimmed.dropLast(1).trim() else trimmed
    val nameEnd = body.indexOfFirst { it.isWhitespace() }
    val name = (if (nameEnd == -1) body else body.substring(0, nameEnd)).lowercase()
    return if (name in VOID_TAGS || selfClosing) {
        RtToken.Void(name)
    } else if (name == "a") {
        RtToken.Open(name, extractHref(body))
    } else {
        RtToken.Open(name, null)
    }
}

private val HREF_DOUBLE_QUOTED = Regex("""href\s*=\s*"([^"]*)"""")
private val HREF_SINGLE_QUOTED = Regex("""href\s*=\s*'([^']*)'""")

/**
 * Defense-in-depth: mirrors the server's own scheme allowlist
 * (`allowedSchemes: ['http', 'https', 'mailto']` in
 * functions/src/lib/richText.ts's `sanitizeRichText`). The server already
 * strips any other scheme before this string is ever persisted, so this
 * should never trigger in practice — it's a second gate in case that
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
 * (blockquote "▍ " markers, list-item bullets/numbers) is applied lazily —
 * only when real content is about to be written — so a block element that's
 * the first thing inside an `<li>` or `<blockquote>` doesn't wrongly trigger
 * an extra blank line before it.
 */
private class RichTextRenderState(val builder: androidx.compose.ui.text.AnnotatedString.Builder) {
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
        // text) — each one needs the same line-start decoration treatment as
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
                val linkStyle = SpanStyle(color = KinfolkBrand.KinTeal, textDecoration = TextDecoration.Underline)
                val linkIndex = rb.builder.pushLink(LinkAnnotation.Url(href, TextLinkStyles(style = linkStyle)))
                renderNodes(el.children, rb)
                rb.builder.pop(linkIndex)
            }
        }
        else -> {
            // Not part of the allowed tag subset. sanitizeRichText() guarantees
            // this shouldn't happen; fall back to rendering children plainly
            // rather than crashing.
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
