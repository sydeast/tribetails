package com.tribetails.auntieos.ui.inbox

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
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
    @Test fun storedMessageBodiesReadBackAsTyped() {
        // Stored exactly as the server writes them (mytribe/functions/test/fixtures/messageBodies.json).
        val cases = listOf(
            "a &lt; b" to "a < b",
            "use the &lt;side gate&gt; today" to "use the <side gate> today",
            "the entity &amp;lt; is how you write &lt;" to "the entity &lt; is how you write <",
            "Tom &amp;amp; Jerry &amp; friends" to "Tom &amp; Jerry & friends",
            "write to Pawsome &lt;pawsome@hanasamku.com&gt; or &lt;catch@hanasamku.com&gt;" to
                "write to Pawsome <pawsome@hanasamku.com> or <catch@hanasamku.com>",
            "I use &lt;script&gt;alert(1)&lt;/script&gt; tags" to "I use <script>alert(1)</script> tags",
            "line one\nline two &gt; three" to "line one\nline two > three",
            "<p>a &lt; b and &lt;side gate&gt; and <strong>bold</strong></p>" to "a < b and <side gate> and bold",
            "<p>the entity &amp;lt; and Tom &amp;amp; Jerry</p>" to "the entity &lt; and Tom &amp; Jerry",
        )
        for ((stored, typed) in cases) {
            val shown = if (hasRichTextMarkup(stored)) richTextToAnnotatedString(stored).text else messageBodyText(stored)
            assertEquals(typed, shown)
            assertEquals(typed, richTextToAnnotatedString(stored).text)
        }
    }
    @Test fun plainTextIsEscapedForSending() {
        assertEquals("a &lt; b, the &lt;side gate&gt; &amp; &amp;lt;", plainTextToMessageBody("a < b, the <side gate> & &lt;"))
        assertEquals("<side gate>", messageBodyText(plainTextToMessageBody("<side gate>")))
    }
    @Test fun storedHostileBodiesAreTextWithNoLink() {
        val r = richTextToAnnotatedString("&lt;img src=x onerror=alert(1)&gt; &lt;a href=`javascript:alert(1)`&gt;x <a>y</a>")
        assertEquals("<img src=x onerror=alert(1)> <a href=`javascript:alert(1)`>x y", r.text)
        assertEquals(0, r.getLinkAnnotations(0, r.length).size)
    }
}
