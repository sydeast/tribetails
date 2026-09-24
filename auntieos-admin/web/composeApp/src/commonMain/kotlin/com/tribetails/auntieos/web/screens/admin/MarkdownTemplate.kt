package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.TemplateService

/**
 * 13.3/13.4 Template Bank rich editor (web/desktop). Pure, Compose-free core, shared by
 * the SAVE path and the live PREVIEW so they can never drift:
 *   markdown -> [parseMarkdown] -> List<[MdBlock]> -> [blocksToHtml] (email HTML, into
 *   EmailTemplate.html, sent as-is by SendGrid) AND -> the Compose preview renderer.
 * Subset: # / ## / ### headings, **bold**, _italic_, [text](url), ![alt](url), "- "
 * bullets, blank-line paragraphs, single newline -> <br>. Handlebars {{vars}} pass
 * through untouched; HTML special chars in text are escaped (input never trusted as
 * HTML). Plus [wrapSelection] / [insertSnippet] toolbar edits. Mirrored on android.
 * See [MarkdownTemplateTest].
 */

// ── Block / inline model ─────────────────────────────────────────────────────

sealed interface MdInline {
    data class Text(val text: String) : MdInline
    data class Bold(val text: String) : MdInline
    data class Italic(val text: String) : MdInline
    data class Link(val text: String, val url: String) : MdInline
    data class Image(val alt: String, val url: String) : MdInline
}

sealed interface MdBlock {
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock
    /** A paragraph is one-or-more rendered lines (single newlines -> <br>). */
    data class Paragraph(val lines: List<List<MdInline>>) : MdBlock
    data class BulletList(val items: List<List<MdInline>>) : MdBlock
}

// ── Inline parsing ───────────────────────────────────────────────────────────

private class Span(val inline: MdInline, val end: Int)

/** Image at [i] (![alt](url)), else null. */
private fun imageAt(s: String, i: Int): Span? {
    if (i + 1 >= s.length || s[i] != '!' || s[i + 1] != '[') return null
    val close = s.indexOf(']', i + 2); if (close < 0) return null
    if (close + 1 >= s.length || s[close + 1] != '(') return null
    val end = s.indexOf(')', close + 2); if (end < 0) return null
    return Span(MdInline.Image(s.substring(i + 2, close), s.substring(close + 2, end)), end + 1)
}

/** Link at [i] ([text](url)), else null. */
private fun linkAt(s: String, i: Int): Span? {
    if (s[i] != '[') return null
    val close = s.indexOf(']', i + 1); if (close < 0) return null
    if (close + 1 >= s.length || s[close + 1] != '(') return null
    val end = s.indexOf(')', close + 2); if (end < 0) return null
    return Span(MdInline.Link(s.substring(i + 1, close), s.substring(close + 2, end)), end + 1)
}

/** A [delim]-wrapped span at [i] whose inner contains no delim char (matches [^d]+), else null. */
private fun delimAt(s: String, i: Int, delim: String, bold: Boolean): Span? {
    if (!s.startsWith(delim, i)) return null
    val from = i + delim.length
    val end = s.indexOf(delim, from); if (end < 0) return null
    val inner = s.substring(from, end)
    if (inner.isEmpty() || inner.contains(delim[0])) return null
    val node = if (bold) MdInline.Bold(inner) else MdInline.Italic(inner)
    return Span(node, end + delim.length)
}

/** Parse one line of text into inline spans (image > link > bold > italic > text). */
fun parseInline(s: String): List<MdInline> {
    val out = mutableListOf<MdInline>()
    val buf = StringBuilder()
    fun flush() { if (buf.isNotEmpty()) { out.add(MdInline.Text(buf.toString())); buf.clear() } }
    var i = 0
    while (i < s.length) {
        val span = imageAt(s, i)
            ?: linkAt(s, i)
            ?: delimAt(s, i, "**", bold = true)
            ?: delimAt(s, i, "_", bold = false)
        if (span != null) { flush(); out.add(span.inline); i = span.end } else { buf.append(s[i]); i++ }
    }
    flush()
    return out
}

// ── Block parsing ────────────────────────────────────────────────────────────

/** Constrained Markdown -> blocks. */
fun parseMarkdown(markdown: String): List<MdBlock> {
    val lines = markdown.replace("\r\n", "\n").split("\n")
    val out = mutableListOf<MdBlock>()
    val para = mutableListOf<List<MdInline>>()
    fun flushPara() { if (para.isNotEmpty()) { out.add(MdBlock.Paragraph(para.toList())); para.clear() } }

    var i = 0
    while (i < lines.size) {
        val line = lines[i].trimEnd()
        when {
            line.isBlank() -> { flushPara(); i++ }
            line.startsWith("### ") -> { flushPara(); out.add(MdBlock.Heading(3, parseInline(line.removePrefix("### ")))); i++ }
            line.startsWith("## ") -> { flushPara(); out.add(MdBlock.Heading(2, parseInline(line.removePrefix("## ")))); i++ }
            line.startsWith("# ") -> { flushPara(); out.add(MdBlock.Heading(1, parseInline(line.removePrefix("# ")))); i++ }
            line.startsWith("- ") -> {
                flushPara()
                val items = mutableListOf<List<MdInline>>()
                while (i < lines.size && lines[i].trimEnd().startsWith("- ")) {
                    items.add(parseInline(lines[i].trimEnd().removePrefix("- "))); i++
                }
                out.add(MdBlock.BulletList(items))
            }
            else -> { para.add(parseInline(line)); i++ }
        }
    }
    flushPara()
    return out
}

// ── HTML emit (the SAVE path) ────────────────────────────────────────────────

private fun escapeHtml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

private fun inlineToHtml(inlines: List<MdInline>): String = buildString {
    for (n in inlines) when (n) {
        is MdInline.Text -> append(escapeHtml(n.text))
        is MdInline.Bold -> append("<strong>").append(escapeHtml(n.text)).append("</strong>")
        is MdInline.Italic -> append("<em>").append(escapeHtml(n.text)).append("</em>")
        is MdInline.Link -> append("<a href=\"").append(escapeHtml(n.url)).append("\">").append(escapeHtml(n.text)).append("</a>")
        is MdInline.Image -> append("<img src=\"").append(escapeHtml(n.url)).append("\" alt=\"").append(escapeHtml(n.alt)).append("\">")
    }
}

fun blocksToHtml(blocks: List<MdBlock>): String = buildString {
    for (b in blocks) when (b) {
        is MdBlock.Heading -> append("<h${b.level}>").append(inlineToHtml(b.inlines)).append("</h${b.level}>")
        is MdBlock.Paragraph -> append("<p>").append(b.lines.joinToString("<br>") { inlineToHtml(it) }).append("</p>")
        is MdBlock.BulletList -> { append("<ul>"); b.items.forEach { append("<li>").append(inlineToHtml(it)).append("</li>") }; append("</ul>") }
    }
}

/** Constrained Markdown -> HTML for an email body (parse once, emit). */
fun markdownToHtml(markdown: String): String = blocksToHtml(parseMarkdown(markdown))

// ── Toolbar edits ────────────────────────────────────────────────────────────

/** Toolbar edit result: the new [text] and the [cursor] position to place after. */
data class MarkdownEdit(val text: String, val cursor: Int)

/**
 * Wrap [text]'s [selStart,selEnd) range with [prefix]/[suffix]. With no selection
 * (selStart == selEnd) the cursor lands between the markers; with a selection it lands
 * just after the closing marker.
 */
fun wrapSelection(text: String, selStart: Int, selEnd: Int, prefix: String, suffix: String): MarkdownEdit {
    val s = selStart.coerceIn(0, text.length)
    val e = selEnd.coerceIn(s, text.length)
    val out = text.substring(0, s) + prefix + text.substring(s, e) + suffix + text.substring(e)
    val cursor = if (s == e) s + prefix.length else s + prefix.length + (e - s) + suffix.length
    return MarkdownEdit(out, cursor)
}

/** Insert [snippet] at [cursor]; the cursor lands just after it. */
fun insertSnippet(text: String, cursor: Int, snippet: String): MarkdownEdit {
    val c = cursor.coerceIn(0, text.length)
    return MarkdownEdit(text.substring(0, c) + snippet + text.substring(c), c + snippet.length)
}

// ── Edit mode (#953 PR 1) ────────────────────────────────────────────────────

/** #953 PR 1: what this device may change on a template. */
enum class TemplateEditMode { FULL, SUBJECT_ONLY, READ_ONLY }

/**
 * True when [html] was not produced by this app's own [markdownToHtml] from
 * [body]: a seed's branded design, or HTML written on the web admin. Saving it
 * from here used to replace it with markdown output and destroy the design.
 */
fun htmlIsHandAuthored(body: String, html: String?): Boolean =
    !html.isNullOrBlank() && html != markdownToHtml(body)

fun templateEditMode(template: TemplateService.EmailTemplate, creating: Boolean): TemplateEditMode = when {
    creating -> TemplateEditMode.FULL
    template.format != null -> TemplateEditMode.READ_ONLY
    htmlIsHandAuthored(template.body, template.html) -> TemplateEditMode.SUBJECT_ONLY
    else -> TemplateEditMode.FULL
}

/** The template a Save sends, given the mode. READ_ONLY never reaches here: the screen hides Save. */
fun templateToSave(
    original: TemplateService.EmailTemplate,
    mode: TemplateEditMode,
    editedSubject: String,
    editedBody: String,
): TemplateService.EmailTemplate = when (mode) {
    TemplateEditMode.SUBJECT_ONLY -> original.copy(subject = editedSubject)
    else -> original.copy(subject = editedSubject, body = editedBody, html = markdownToHtml(editedBody).ifBlank { null })
}
