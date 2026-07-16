package com.kinfolk.portal.text

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RichTextHtmlTest {

    @Test
    fun plainText_noTags_rendersIdentically() {
        val result = richTextToAnnotatedString("Fed the dog, all good.")
        assertEquals("Fed the dog, all good.", result.text)
        assertTrue(result.spanStyles.isEmpty())
    }

    @Test
    fun emptyString_rendersEmpty() {
        val result = richTextToAnnotatedString("")
        assertEquals("", result.text)
    }

    @Test
    fun bold_bTag() {
        val result = richTextToAnnotatedString("<b>call me</b>")
        assertEquals("call me", result.text)
        assertTrue(result.spanStyles.any { it.item.fontWeight == FontWeight.Bold && it.start == 0 && it.end == 7 })
    }

    @Test
    fun bold_strongTag() {
        val result = richTextToAnnotatedString("<strong>call me</strong>")
        assertEquals("call me", result.text)
        assertTrue(result.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
    }

    @Test
    fun italic_iAndEmTags() {
        val i = richTextToAnnotatedString("<i>water</i>")
        assertEquals("water", i.text)
        assertTrue(i.spanStyles.any { it.item.fontStyle == FontStyle.Italic })

        val em = richTextToAnnotatedString("<em>water</em>")
        assertEquals("water", em.text)
        assertTrue(em.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
    }

    @Test
    fun underline_uTag() {
        val result = richTextToAnnotatedString("<u>at 5pm</u>")
        assertEquals("at 5pm", result.text)
        assertTrue(result.spanStyles.any { it.item.textDecoration == TextDecoration.Underline })
    }

    @Test
    fun paragraph_separatesWithSingleNewline_noTrailingBreak() {
        val result = richTextToAnnotatedString("<p>First</p><p>Second</p>")
        assertEquals("First\nSecond", result.text)
    }

    @Test
    fun paragraph_singleParagraph_noTrailingNewline() {
        val result = richTextToAnnotatedString("<p>Hello</p>")
        assertEquals("Hello", result.text)
    }

    @Test
    fun br_singleLineBreak() {
        val result = richTextToAnnotatedString("Line1<br>Line2")
        assertEquals("Line1\nLine2", result.text)
    }

    @Test
    fun br_selfClosingVariant() {
        val result = richTextToAnnotatedString("Line1<br/>Line2")
        assertEquals("Line1\nLine2", result.text)
    }

    @Test
    fun unorderedList_bulletsEachItem() {
        val result = richTextToAnnotatedString("<ul><li>Fed breakfast</li><li>Walked at noon</li></ul>")
        assertEquals("• Fed breakfast\n• Walked at noon", result.text)
    }

    @Test
    fun orderedList_numbersResetPerList() {
        val result = richTextToAnnotatedString(
            "<ol><li>First</li><li>Second</li></ol><ol><li>Restarted</li></ol>",
        )
        assertEquals("1. First\n2. Second\n1. Restarted", result.text)
    }

    @Test
    fun blockquote_prefixesEachLine() {
        val result = richTextToAnnotatedString("<blockquote>Line one<br>Line two</blockquote>")
        assertEquals("▍ Line one\n▍ Line two", result.text)
    }

    @Test
    fun link_visibleTextAndTappableAnnotation() {
        val result = richTextToAnnotatedString("""<a href="https://example.com/x?a=1&amp;b=2">tap here</a>""")
        assertEquals("tap here", result.text)

        val links = result.getLinkAnnotations(0, result.length)
        assertEquals(1, links.size)
        val url = links.first().item as LinkAnnotation.Url
        // Entity-decoded exactly like the server's decodeEntities does.
        assertEquals("https://example.com/x?a=1&b=2", url.url)
        // Visual link style is carried on the LinkAnnotation itself (applied
        // by Text()'s link-rendering, not as a separate top-level SpanStyle).
        assertEquals(TextDecoration.Underline, url.styles?.style?.textDecoration)
    }

    @Test
    fun link_mailtoScheme() {
        val result = richTextToAnnotatedString("""<a href="mailto:auntie@example.com">email us</a>""")
        assertEquals("email us", result.text)
        val url = result.getLinkAnnotations(0, result.length).first().item as LinkAnnotation.Url
        assertEquals("mailto:auntie@example.com", url.url)
    }

    @Test
    fun link_disallowedSchemeRendersAsPlainTextNoTappableAnnotation() {
        // Defense-in-depth: the server already strips non-http/https/mailto
        // hrefs (sanitizeRichText's allowedSchemes), so this string should
        // never actually reach the client in practice — this pins the
        // client-side second gate regardless.
        val result = richTextToAnnotatedString("""<a href="javascript:alert(1)">click</a>""")
        assertEquals("click", result.text)
        assertTrue(result.getLinkAnnotations(0, result.length).isEmpty())
    }

    @Test
    fun nestedCombination_paragraphWithInlineBoldAndItalicAndEntity() {
        val result = richTextToAnnotatedString("<p>Fed <strong>Rex</strong> & gave <em>water</em></p>")
        assertEquals("Fed Rex & gave water", result.text)
        assertTrue(result.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(result.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
    }

    @Test
    fun listInsideBlockquote_combinesLinePrefixes() {
        val result = richTextToAnnotatedString("<blockquote><ul><li>a</li><li>b</li></ul></blockquote>")
        assertEquals("▍ • a\n▍ • b", result.text)
    }

    @Test
    fun paragraphInsideListItem_doesNotInsertSpuriousBreak() {
        // ProseMirror/TipTap-style bullet lists often wrap each item's text
        // in its own <p>; that must not push the item's text onto a second line.
        val result = richTextToAnnotatedString("<ul><li><p>Item A</p></li><li><p>Item B</p></li></ul>")
        assertEquals("• Item A\n• Item B", result.text)
    }

    @Test
    fun htmlEntities_decodeAllFive() {
        val result = richTextToAnnotatedString("Bob &amp; Sue said &quot;hi&quot; &lt;there&gt; it&#39;s fine")
        assertEquals("Bob & Sue said \"hi\" <there> it's fine", result.text)
    }

    @Test
    fun htmlEntities_ampDecodedLast_doesNotResurrectTag() {
        // A user who literally typed "&lt;script&gt;" as text (not a real tag)
        // must come back out as the literal string, never as a live "<script>".
        val result = richTextToAnnotatedString("&amp;lt;script&amp;gt;")
        assertEquals("&lt;script&gt;", result.text)
    }

    @Test
    fun allowedTagSubset_fromRichTextTs_roundTrips() {
        // Mirrors ALLOWED_TAGS in functions/src/lib/richText.ts exactly:
        // ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'a']
        val html = "<p><b>bold</b> <strong>strong</strong> <i>italic</i> <em>em</em> " +
            "<u>underline</u><br>next line " +
            "<a href=\"https://example.com\">a link</a></p>" +
            "<ul><li>bullet one</li><li>bullet two</li></ul>" +
            "<ol><li>step one</li><li>step two</li></ol>" +
            "<blockquote>quoted text</blockquote>"

        val result = richTextToAnnotatedString(html)

        assertTrue(result.text.contains("bold strong italic em"))
        assertTrue(result.text.contains("underline\nnext line a link"))
        assertTrue(result.text.contains("• bullet one\n• bullet two"))
        assertTrue(result.text.contains("1. step one\n2. step two"))
        assertTrue(result.text.contains("▍ quoted text"))
        assertTrue(result.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(result.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
        assertTrue(result.spanStyles.any { it.item.textDecoration == TextDecoration.Underline })
        assertEquals(1, result.getLinkAnnotations(0, result.length).size)
    }
}
