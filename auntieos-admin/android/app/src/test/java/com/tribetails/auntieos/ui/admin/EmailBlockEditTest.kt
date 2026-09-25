package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** #953 PR 5: the phone changes words and nothing else. */
class EmailBlockEditTest {

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"

    // Stored void elements are <br> and <img …> (ruling C4: the sanitizer's form).
    private val reset =
        "<p>Hi <strong>{{displayName}}</strong>, we got a request to reset your password.</p>" +
            "<p><a href=\"{{link}}\" class=\"button\">Reset your password</a></p>" +
            "<h3>If you didn't ask</h3>" +
            "<ul><li>You can ignore this <em>email</em>.</li><li>Your password stays the same.</li></ul>" +
            "<blockquote><p>The link works for <strong>one hour</strong>.</p></blockquote>" +
            "<p>Questions? <a href=\"mailto:help@tribetails.com\">Write to us</a>.<br>Take care,<br><strong>Auntie</strong></p>" +
            "<p><img src=\"$img\" alt=\"Tribe Tails\"></p>"

    private fun block(html: String) = parseEmailContent(html).single() as EmailBlock.TextBlock

    private fun edit(html: String, newText: String): String {
        val r = applyBlockEdit(block(html), newText)
        assertTrue("expected Accepted, got $r", r is BlockEdit.Accepted)
        return serializeEmailContent(listOf((r as BlockEdit.Accepted).block))
    }

    private fun refusal(html: String, newText: String): String {
        val r = applyBlockEdit(block(html), newText)
        assertTrue("expected Rejected, got $r", r is BlockEdit.Rejected)
        return (r as BlockEdit.Rejected).reason
    }

    private fun tags(s: String) = Regex("<[^>]+>").findAll(s).map { it.value }.toList()

    private fun codePointBoundaries(s: String): List<Int> {
        val out = mutableListOf(0)
        var k = 0
        while (k < s.length) {
            k += Character.charCount(s.codePointAt(k))
            out += k
        }
        return out
    }

    @Test fun changingAWordKeepsTheBoldAroundIt() {
        assertEquals("<p>Hello <strong>dear</strong> friend</p>", edit("<p>Hello <strong>dear</strong> reader</p>", "Hello dear friend"))
        assertEquals("<p>Hello <strong>kind</strong> reader</p>", edit("<p>Hello <strong>dear</strong> reader</p>", "Hello kind reader"))
    }

    @Test fun typingAfterABoldWordContinuesTheBold() {
        assertEquals("<p>Hi <strong>you!</strong></p>", edit("<p>Hi <strong>you</strong></p>", "Hi you!"))
    }

    @Test fun typingAfterALinkPrefersThePlainTextBeside() {
        assertEquals(
            "<p>See <a href=\"https://x.com\">help</a>, now</p>",
            edit("<p>See <a href=\"https://x.com\">help</a> now</p>", "See help, now"),
        )
    }

    @Test fun breaksAndHtmlEscapesSurviveAnEdit() {
        assertEquals("<p>1 &lt; 3 &amp; b<br>c</p>", edit("<p>1 &lt; 2 &amp; b<br>c</p>", "1 < 3 & b\nc"))
        // A break is kept as written, so the <br /> spelling survives an edit too.
        assertEquals("<p>x<br />z</p>", edit("<p>x<br />y</p>", "x\nz"))
    }

    @Test fun anUneditedRunKeepsItsSourceSpelling() {
        // &#39; is not what the sanitizer writes, but a run nobody touched is written back as found.
        assertEquals("<p>it&#39;s <strong>ok</strong> now</p>", edit("<p>it&#39;s <strong>ok</strong> then</p>", "it's ok now"))
    }

    // Review Focus 1
    @Test fun aParagraphThatIsEntirelyALinkKeepsTheLinkThroughAnyWordEdit() {
        val p = "<p><a href=\"https://tribetails.com/help\">Get help</a></p>"
        assertEquals("<p><a href=\"https://tribetails.com/help\">Find help</a></p>", edit(p, "Find help"))
        assertEquals("<p><a href=\"https://tribetails.com/help\">Support</a></p>", edit(p, "Support"))
        assertEquals("<p><a href=\"https://tribetails.com/help\">Get help!</a></p>", edit(p, "Get help!"))
        assertEquals(EDIT_KEEP_FORMATTING, refusal(p, ""))
    }

    // Review Focus 2
    @Test fun emojiAreReplacedWholeAndNeverSplit() {
        assertEquals("<p>Hi <strong>😁</strong> there</p>", edit("<p>Hi <strong>😀</strong> there</p>", "Hi 😁 there"))
        assertEquals("<p>Hi <strong>you👋</strong></p>", edit("<p>Hi <strong>you</strong></p>", "Hi you👋"))
        assertEquals("<p>Family  photo</p>", edit("<p>Family 👩‍👩‍👧 photo</p>", "Family  photo"))
        assertEquals("<p>a<strong>😁😀</strong></p>", edit("<p>a<strong>😀</strong></p>", "a😁😀"))
        val r = applyBlockEdit(block("<p>Hi <strong>😀</strong> there</p>"), "Hi 😁 there") as BlockEdit.Accepted
        assertEquals(5, r.cursor)
        assertFalse(Character.isLowSurrogate("Hi 😁 there"[r.cursor]))
    }

    // Review Focus 3
    @Test fun aMergeFieldIsNeverHalfEdited() {
        val p = "<p>Hi {{displayName}}, welcome</p>"
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Hi {{dispXlayName}}, welcome"))
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Hi Xname}}, welcome"))
        assertEquals("<p>Hi , welcome</p>", edit(p, "Hi {{displayName}, welcome"))
        assertEquals("<p>Hi Pat, welcome</p>", edit(p, "Hi Pat, welcome"))
    }

    @Test fun aFreshlyTypedMergeFieldIsJustText() {
        assertEquals("<p>Hi {{name}}</p>", edit("<p>Hi </p>", "Hi {{name}}"))
        assertTrue(hasBrokenMergeField("Hi {{na"))
        assertTrue(hasBrokenMergeField("Hi name}}"))
        assertFalse(hasBrokenMergeField("Hi {{name}} and {{ link }}"))
    }

    @Test fun aButtonLabelChangesAndItsTargetDoesNot() {
        assertEquals(
            "<p><a href=\"{{link}}\" class=\"button\">Choose a new password</a></p>",
            edit("<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>", "Choose a new password"),
        )
        assertEquals(EDIT_KEEP_FORMATTING, refusal("<p><a href=\"{{link}}\" class=\"button\">Go</a></p>", ""))
    }

    @Test fun lineBreaksAndInlineImagesAreStructure() {
        assertEquals(EDIT_NO_NEW_LINES, refusal("<p>one</p>", "o\nne"))
        assertEquals(EDIT_LOCKED_STRUCTURE, refusal("<p>a<br>b</p>", "ab"))
        assertEquals(EDIT_LOCKED_STRUCTURE, refusal("<p>see <img src=\"$img\" alt=\"i\"> it</p>", "see  it"))
    }

    @Test fun formattingCannotBeRemovedAndABlockCannotBeEmptied() {
        assertEquals(EDIT_KEEP_FORMATTING, refusal("<p>a <em>b</em> c</p>", "a  c"))
        assertEquals(EDIT_NOT_EMPTY, refusal("<p>plain words</p>", ""))
        assertEquals(EDIT_NOT_EMPTY, refusal("<p>plain words</p>", "   "))
        // Emptying one of two runs inside a link keeps the link, so it is allowed.
        assertEquals(
            "<p><a href=\"mailto:help@tribetails.com\"><em>us</em></a></p>",
            edit("<p><a href=\"mailto:help@tribetails.com\">mail <em>us</em></a></p>", "us"),
        )
    }

    @Test fun wordEditsLeaveEveryTagInPlace() {
        val blocks = parseEmailContent(reset).map { b ->
            if (b !is EmailBlock.TextBlock) return@map b
            val next = b.plainText().replace("password", "passcode").replace("email", "message")
                .replace("hour", "day").replace("us", "the team")
            (applyBlockEdit(b, next) as? BlockEdit.Accepted)?.block ?: b
        }
        val out = serializeEmailContent(blocks)
        assertNotEquals(reset, out)
        assertTrue(out.contains("<a href=\"{{link}}\" class=\"button\">Reset your passcode</a>"))
        assertTrue(out.contains("<em>message</em>"))
        assertTrue(out.contains("<strong>one day</strong>"))
        assertEquals(tags(reset), tags(out))
    }

    @Test fun noSequenceOfEditsAddsRemovesOrReshapesABlock() {
        val random = Random(5)
        val alphabet = listOf("a", " ", "é", "😀", "{", "}", "{{name}}", "<", "&", "")
        val original = parseEmailContent(reset)
        var blocks = original
        repeat(2000) {
            val i = random.nextInt(blocks.size)
            val b = blocks[i] as? EmailBlock.TextBlock ?: return@repeat
            val text = b.plainText()
            val cuts = codePointBoundaries(text)
            val from = cuts[random.nextInt(cuts.size)]
            val later = cuts.filter { it >= from }
            val to = later[random.nextInt(later.size)]
            val next = text.substring(0, from) + alphabet[random.nextInt(alphabet.size)] + text.substring(to)
            val r = applyBlockEdit(b, next)
            if (r is BlockEdit.Accepted) blocks = blocks.toMutableList().also { it[i] = r.block }
        }
        val out = serializeEmailContent(blocks)
        val reparsed = parseEmailContent(out)
        assertEquals(original.size, reparsed.size)
        original.zip(reparsed).forEach { (a, b) ->
            assertEquals(a::class, b::class)
            assertEquals(a.lead, b.lead)
            assertEquals(a.trail, b.trail)
            if (a is EmailBlock.TextBlock) assertEquals(a.kind, (b as EmailBlock.TextBlock).kind)
        }
        assertEquals(tags(reset), tags(out))
        out.forEachIndexed { k, ch ->
            if (ch.isHighSurrogate()) assertTrue("lone high surrogate at $k", k + 1 < out.length && out[k + 1].isLowSurrogate())
            if (ch.isLowSurrogate()) assertTrue("lone low surrogate at $k", k > 0 && out[k - 1].isHighSurrogate())
        }
        // The edited body reads back as the same blocks and writes out unchanged.
        assertEquals(out, serializeEmailContent(reparsed))
    }

    // ── beyond the plan's 14 ──────────────────────────────────────────────────

    @Test fun noEditCanTypeALoopOrConditional() {
        val p = "<p>Hi {{name}}, welcome</p>"
        for (typed in listOf("{{#each pets}}", "{{/each}}", "{{^pets}}", "{{else}}", "{{ #if x}}", "{{#")) {
            assertEquals(typed, EDIT_NO_BLOCK_HELPER, refusal(p, "Hi {{name}}, $typed welcome"))
        }
        // Typing "{{" beside a "#" already in the text would open a helper too.
        assertEquals(EDIT_NO_BLOCK_HELPER, refusal("<p>Tag #pets</p>", "Tag {{#pets"))
        assertEquals(EDIT_NO_BLOCK_HELPER, refusal("<ul><li>a /b</li></ul>", "a {{/b"))
        // Backspace into {{name}} takes the whole field, which would leave "{{#" behind.
        assertEquals(EDIT_NO_BLOCK_HELPER, refusal("<p>{{{{name}}#</p>", "{{{{name}#"))
        // A lone brace or a plain word "else" is fine.
        assertEquals("<p>Hi {{name}}, or else welcome</p>", edit(p, "Hi {{name}}, or else welcome"))
    }

    @Test fun backspaceIntoAMergeFieldTakesAllOfIt() {
        val p = "<p>Dear {{displayName}}!</p>"
        // Backspace on the closing brace.
        assertEquals("<p>Dear !</p>", edit(p, "Dear {{displayName}!"))
        // Delete on the opening brace.
        assertEquals("<p>Dear !</p>", edit(p, "Dear {displayName}}!"))
        // A selection from inside the field out past it, with nothing typed.
        assertEquals("<p>Dear </p>", edit(p, "Dear {{disp"))
        // Typing inside the field, or over part of it, is refused.
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Dear {{displayXName}}!"))
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Dear {{dispX!"))
        // Typing right before or after it is plain typing.
        assertEquals("<p>Dear X{{displayName}}Y!</p>", edit(p, "Dear X{{displayName}}Y!"))
        // Replacing the whole field is fine.
        assertEquals("<p>Dear Pat!</p>", edit(p, "Dear Pat!"))
    }

    @Test fun aMergeFieldInsideBoldIsKeptWhole() {
        val p = "<p>Hi <strong>{{displayName}}</strong> there</p>"
        assertEquals(EDIT_WHOLE_MERGE_FIELD, refusal(p, "Hi {{displayNameX}} there"))
        // Deleting the whole field would empty the bold, which is formatting.
        assertEquals(EDIT_KEEP_FORMATTING, refusal(p, "Hi {{displayName} there"))
        assertEquals("<p>Hi <strong>{{displayName}}</strong> friend</p>", edit(p, "Hi {{displayName}} friend"))
    }

    @Test fun aButtonKeepsItsTargetAndOnlyItsLabelChanges() {
        val html = "<p> <a href=\"{{link}}\" class=\"button\">Pay now</a> </p>"
        val b = block(html)
        assertEquals(EmailBlockKind.BUTTON, b.kind)
        val r = applyBlockEdit(b, " Pay today ") as BlockEdit.Accepted
        assertEquals("{{link}}", buttonTarget(r.block))
        assertEquals("<p> <a href=\"{{link}}\" class=\"button\">Pay today</a> </p>", serializeEmailContent(listOf(r.block)))
        // Words outside the link would turn the button back into a paragraph.
        assertEquals(EDIT_BUTTON_LABEL_ONLY, refusal(html, "x Pay now "))
        assertEquals(EDIT_BUTTON_LABEL_ONLY, refusal(html, " Pay now x"))
        assertEquals(EDIT_BUTTON_LABEL_ONLY, refusal(html, "Pay now "))
        // Typing right after the label extends the label.
        assertEquals("<p> <a href=\"{{link}}\" class=\"button\">Pay now!</a> </p>", edit(html, " Pay now! "))
    }

    @Test fun aParagraphCannotBeTurnedIntoAButtonOrAnImage() {
        val withButton = "<p>Tap <a href=\"{{link}}\" class=\"button\">Go</a></p>"
        assertEquals(EmailBlockKind.PARAGRAPH, block(withButton).kind)
        assertEquals(EDIT_KEEP_WORDS_BESIDE, refusal(withButton, "Go"))
        assertEquals("<p>Now <a href=\"{{link}}\" class=\"button\">Go</a></p>", edit(withButton, "Now Go"))

        val withImage = "<p>Look <img src=\"$img\" alt=\"i\"></p>"
        assertEquals(EDIT_NOT_EMPTY, refusal(withImage, "$EMAIL_IMAGE_CHAR"))
        assertEquals("<p>See <img src=\"$img\" alt=\"i\"></p>", edit(withImage, "See $EMAIL_IMAGE_CHAR"))
    }

    @Test fun typedMarkupIsEscapedText() {
        val out = edit("<p>Hello there</p>", "Hello <b>there</b> & <script>x</script>")
        assertEquals("<p>Hello &lt;b&gt;there&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;</p>", out)
        val again = parseEmailContent(out).single() as EmailBlock.TextBlock
        assertEquals("Hello <b>there</b> & <script>x</script>", again.plainText())
        assertEquals(listOf("<p>", "</p>"), tags(out))
    }

    @Test fun headingsListItemsAndCalloutsEditLikeParagraphs() {
        val blocks = parseEmailContent(reset)
        val heading = blocks.first { it is EmailBlock.TextBlock && it.kind == EmailBlockKind.HEADING3 } as EmailBlock.TextBlock
        val item = blocks.first { it is EmailBlock.TextBlock && it.kind == EmailBlockKind.BULLET_ITEM } as EmailBlock.TextBlock
        val callout = blocks.first { it is EmailBlock.TextBlock && it.kind == EmailBlockKind.CALLOUT } as EmailBlock.TextBlock

        val h = (applyBlockEdit(heading, "If you did not ask") as BlockEdit.Accepted).block
        assertEquals("<h3>If you did not ask</h3>", serializeEmailContent(listOf(h)))

        val li = (applyBlockEdit(item, "You can skip this email.") as BlockEdit.Accepted).block
        assertEquals("<ul><li>You can skip this <em>email</em>.</li>", serializeEmailContent(listOf(li)))

        val c = (applyBlockEdit(callout, "The link lasts for one hour.") as BlockEdit.Accepted).block
        assertEquals("<blockquote><p>The link lasts for <strong>one hour</strong>.</p></blockquote>", serializeEmailContent(listOf(c)))
    }

    @Test fun anEditedBodyRoundTripsStably() {
        val blocks = parseEmailContent(reset).map { b ->
            if (b !is EmailBlock.TextBlock) return@map b
            val next = b.plainText().replace("a ", "one ") + " 😀 & <ok>"
            (applyBlockEdit(b, next) as? BlockEdit.Accepted)?.block ?: b
        }
        val once = serializeEmailContent(blocks)
        val reparsed = parseEmailContent(once)
        assertEquals(once, serializeEmailContent(reparsed))
        assertEquals(blocks.map { it::class }, reparsed.map { it::class })
        assertEquals(
            blocks.map { (it as? EmailBlock.TextBlock)?.plainText() },
            reparsed.map { (it as? EmailBlock.TextBlock)?.plainText() },
        )
        assertEquals(tags(reset), tags(once))
        // Nothing typed reaches the output as a raw < or an unescaped &.
        val text = once.replace(Regex("<[^>]+>"), "")
        assertFalse(text.contains('<'))
        assertFalse(Regex("&(?!amp;|lt;|gt;|#39;)").containsMatchIn(text))
    }

    @Test fun lockedAndImageBlocksAreNotTextBlocks() {
        val html = "<p>Your pets:</p><ul>{{#each pets}}<li>{{this.name}}</li>{{/each}}</ul>" +
            "<p>Hi {{#if x}}there{{/if}}</p><p><img src=\"$img\" alt=\"i\"></p>"
        val blocks = parseEmailContent(html)
        assertEquals(1, blocks.count { it is EmailBlock.TextBlock })
        assertTrue(blocks.any { it is EmailBlock.ImageBlock })
        assertEquals(2, blocks.count { it is EmailBlock.LockedBlock })
        val first = blocks.first() as EmailBlock.TextBlock
        val edited = blocks.toMutableList().also { it[0] = (applyBlockEdit(first, "Your animals:") as BlockEdit.Accepted).block }
        assertEquals(html.replace("Your pets:", "Your animals:"), serializeEmailContent(edited))
    }
}
