package com.tribetails.auntieos.ui.inbox

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
    @Test fun scriptContentIsDroppedAndUnknownTagsUnwrapped() {
        val r = richTextToAnnotatedString("a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>")
        assertEquals("abcd", r.text)
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
}
