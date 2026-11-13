package com.tribetails.auntieos.web.screens.inbox

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontWeight
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/** #1571: the Inbox thread draws kinfolk rich text as formatting, never as raw tags. */
class RichTextHtmlTest {
    @Test fun kinfolkMessageShowsNoTags() {
        val r = richTextToAnnotatedString("<p>Hi Auntie, <strong>please give Sandbox Dog</strong> an extra treat!</p>")
        assertEquals("Hi Auntie, please give Sandbox Dog an extra treat!", r.text)
        assertTrue(r.spanStyles.any { it.item.fontWeight == FontWeight.Bold && r.text.substring(it.start, it.end) == "please give Sandbox Dog" })
    }
    @Test fun plainTextHasNoMarkup() {
        assertFalse(hasRichTextMarkup("2 < 3 and 5 > 4"))
        assertFalse(hasRichTextMarkup("see you at 5"))
        assertTrue(hasRichTextMarkup("<p>x</p>"))
    }
    @Test fun aTagOutsideTheAllowedSubsetIsShownAsTypedText() {
        val r = richTextToAnnotatedString("a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>")
        assertEquals("a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>", r.text)
    }
    @Test fun listRendersAsBullets() {
        val r = richTextToAnnotatedString("<ul><li>one</li><li>two</li></ul>")
        assertEquals("• one\n• two", r.text)
    }
    @Test fun entityEscapedTagStaysInertText() {
        val r = richTextToAnnotatedString("<p>&lt;script&gt;x&lt;/script&gt;</p>")
        assertEquals("<script>x</script>", r.text)
        assertTrue(r.spanStyles.isEmpty())
    }
    @Test fun linkKeepsHttpAndMailtoOnly() {
        val ok = richTextToAnnotatedString("<a href=\"https://example.com\">site</a>")
        assertEquals("site", ok.text)
        assertEquals(1, ok.getLinkAnnotations(0, ok.length).size)
        val mail = richTextToAnnotatedString("<a href=\"mailto:catch@hanasamku.com\">m</a>")
        assertEquals(1, mail.getLinkAnnotations(0, mail.length).size)
        val bad = richTextToAnnotatedString("<a href=\"javascript:alert(1)\">bad</a>")
        assertEquals("bad", bad.text)
        assertEquals(0, bad.getLinkAnnotations(0, bad.length).size)
    }
    @Test fun unterminatedTagDoesNotCrash() {
        assertEquals("text <b unterminated", richTextToAnnotatedString("text <b unterminated").text)
    }
    @Test fun lessThanBesideRealTagsKeepsEveryWord() {
        assertEquals(
            "I think 5 < 6 and 7 > 3 and bold",
            richTextToAnnotatedString("<p>I think 5 < 6 and 7 > 3 and <b>bold</b></p>").text,
        )
        assertEquals("a <b and more words", richTextToAnnotatedString("<p>a <b and more words</p>").text)
        assertEquals("x <y and z\nif a<b and c>d then go", richTextToAnnotatedString("<p>x <y and z</p><p>if a<b and c>d then go</p>").text)
    }
    @Test fun emojiAmpersandAndLineBreakAroundTheSignAreKept() {
        assertEquals("Bella \uD83D\uDC36 & Max < 3\nnext", richTextToAnnotatedString("<p>Bella \uD83D\uDC36 &amp; Max < 3\nnext</p>").text)
    }
    @Test fun aSignAloneOrAtTheEndIsText() {
        assertEquals("<", richTextToAnnotatedString("<").text)
        assertEquals("ends with <", richTextToAnnotatedString("<p>ends with <</p>").text)
        assertFalse(hasRichTextMarkup("a <b and more words</p"))
        assertFalse(hasRichTextMarkup("<script>alert(1)</script>"))
    }
    @Test fun scriptLikeMessageIsShownAsTextWithNoStyleOrLink() {
        val r = richTextToAnnotatedString("""<p><img src=x onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">l</a></p>""")
        assertEquals("""<img src=x onerror="alert(1)"><script>alert(1)</script>l""", r.text)
        assertEquals(0, r.getLinkAnnotations(0, r.length).size)
    }
    @Test fun tagWithAttributesOtherThanQuotedOnesOnALinkIsText() {
        assertEquals("""<p onclick="x()">hi""", richTextToAnnotatedString("""<p onclick="x()">hi</p>""").text)
    }
    @Test fun storedLinkFormsOpenOnlySafeAddresses() {
        // What the server stores for hostile links: an entity inside an href
        // stays an entity, and a tag the clients do not read is text.
        val r = richTextToAnnotatedString(
            "<a href=\"https://example.com/?a=1&amp;b=2\">ok</a> " +
                "<a href=\"java&amp;#x73;cript:alert(1)\">x</a> " +
                "<a href=\"https://example.com/&amp;quot; onclick=&amp;quot;alert(1)\">s</a> " +
                "<a href=`javascript:alert(1)`>y <b onclick=`alert(1)`>z",
        )
        val urls = r.getLinkAnnotations(0, r.length).map { (it.item as LinkAnnotation.Url).url }
        assertEquals(listOf("https://example.com/?a=1&b=2", "https://example.com/&quot; onclick=&quot;alert(1)"), urls)
        assertEquals("ok x s <a href=`javascript:alert(1)`>y <b onclick=`alert(1)`>z", r.text)
    }
}
