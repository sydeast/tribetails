package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

/**
 * #953 PR 5: the phone reads the body the server's sanitizer stored and must
 * write back exactly what it read wherever the operator changed nothing.
 */
class EmailContentRoundTripTest {

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"

    /**
     * What the server stores: `sanitizeEmailContent` (mytribe/functions/src/lib/emailContent.ts)
     * rewrites sanitize-html's `<br />` and `<img … />` to `<br>` and `<img …>`, as all 52 seeds
     * are spelled. Text escapes only & < >, and attributes stay in input order.
     */
    private val canonical = listOf(
        "<p>Hi {{displayName}},</p>",
        "<h2>Reset</h2><h3>Steps</h3>",
        "<p>A <strong>b</strong> <em>c</em><br>d</p>",
        "<ul><li>x</li><li><strong>y</strong> z</li></ul><ol><li>one</li><li>two <em>2</em></li></ol>",
        "<blockquote><p>careful</p></blockquote>",
        "<blockquote><p>one</p><p>two</p></blockquote>",
        "<p><a href=\"https://tribetails.com/help\">Get help</a></p>",
        "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>",
        "<p><a class=\"button\" href=\"{{link}}\">Go</a></p>",
        "<p><img src=\"$img\" alt=\"pup\"></p>",
        "<img src=\"$img\" alt=\"pup\">",
        "<ul><li><p>item <strong>b</strong></p></li></ul>",
        "<p>See <a href=\"https://x.com/?a=1&amp;b=2\"><strong><em>this</em></strong></a> now</p>",
        "<p><strong><a href=\"mailto:help@tribetails.com\">mail <em>us</em></a></strong></p>",
        "<p>1 &lt; 2 &gt; 0 &amp; \"q\" it's</p>",
        "<p>a b café 😀 👩‍👩‍👧</p>",
        "<p>Line one<br>Line two<br><strong>Auntie</strong></p>",
        "<p><a href=\"{{link}}\">{{link}}</a></p>",
        "<p><img src=\"$img\" alt=\"say &quot;hi&quot; &amp; it's\"></p>",
        "<p></p><p>t</p>",
    )

    /**
     * Legal but unusual: whitespace between blocks, sanitize-html's own `<br />` and `<img … />`
     * (with the slash), nesting the phone does not edit, broken markup.
     */
    private val unusual = listOf(
        "<ul>\n<li>x</li>\n</ul>",
        "<p>top</p>\n<p>next</p>",
        "<p>a<br />b</p>",
        "<p><img src=\"$img\" alt=\"pup\" /></p>",
        "<img src=\"$img\" alt=\"pup\" />",
        "<ul><li>outer<ul><li>nested</li></ul></li></ul>",
        "<blockquote><ul><li>x</li></ul></blockquote>",
        "stray text <strong>top</strong>",
        "<p>Text with <img src=\"$img\" alt=\"i\"> inline</p>",
        "<p>unclosed <strong>bold",
        "</p>orphan close",
        "<p>1 < 2</p>",
        "",
    )

    @Test fun everyCanonicalInputRoundTripsByteForByte() {
        for (html in canonical) assertEquals(html, serializeEmailContent(parseEmailContent(html)))
    }

    @Test fun everyUnusualInputRoundTripsByteForByte() {
        for (html in unusual) assertEquals(html, serializeEmailContent(parseEmailContent(html)))
    }

    @Test fun anyStringRoundTrips() {
        val parts = listOf(
            "<p>", "</p>", "<strong>", "</strong>", "<em>", "</em>", "<a href=\"{{link}}\" class=\"button\">",
            "<a href=\"https://x.com\">", "</a>", "<br>", "<br />", "<img src=\"$img\" alt=\"a\">",
            "<img src=\"$img\" alt=\"a\" />", "<ul>", "</ul>",
            "<ol>", "</ol>", "<li>", "</li>", "<h2>", "</h2>", "<h3>", "</h3>", "<blockquote>", "</blockquote>",
            "Hi ", "{{name}}", "{{#each v}}", "{{/each}}", "&amp;", "😀", "\n", " ", "<", ">", "\"",
        )
        val random = Random(953)
        repeat(500) {
            val html = buildString { repeat(random.nextInt(1, 25)) { append(parts[random.nextInt(parts.size)]) } }
            assertEquals(html, serializeEmailContent(parseEmailContent(html)))
        }
    }

    @Test fun blocksAreClassifiedForTheEditor() {
        val kinds = kindsOf(
            parseEmailContent(
                "<h2>Reset</h2><p>Hi <strong>{{displayName}}</strong>,</p><ul><li>a</li></ul><ol><li>b</li><li>c</li></ol>" +
                    "<blockquote><p>careful</p></blockquote><p><a href=\"{{link}}\" class=\"button\">Go</a></p>" +
                    "<p><img src=\"$img\" alt=\"pup\"></p><ul><li>outer<ul><li>nested</li></ul></li></ul>",
            ),
        )
        assertEquals(
            listOf("HEADING2", "PARAGRAPH", "BULLET_ITEM", "NUMBERED_ITEM#1", "NUMBERED_ITEM#2", "CALLOUT", "BUTTON", "IMAGE", "LOCKED"),
            kinds,
        )
    }

    @Test fun plainTextIsWhatTheOperatorReads() {
        val block = parseEmailContent("<p>1 &lt; 2 &amp; <strong>b</strong><br>c</p>").single() as EmailBlock.TextBlock
        assertEquals("1 < 2 & b\nc", block.plainText())
    }

    @Test fun buttonAndImageAttributesAreReadForDisplay() {
        val blocks = parseEmailContent(
            "<p><a href=\"{{link}}\" class=\"button\">Go</a></p><p><img src=\"$img\" alt=\"say &quot;hi&quot;\"></p>",
        )
        assertEquals("{{link}}", buttonTarget(blocks[0] as EmailBlock.TextBlock))
        val image = blocks[1] as EmailBlock.ImageBlock
        assertEquals(img, image.src)
        assertEquals("say \"hi\"", image.alt)
    }

    /** Ruling C5: a block helper (`{{#…}}`, `{{/…}}`, `{{^…}}`, `{{else}}`) locks the block holding it. */
    @Test fun aBlockHelperLocksItsBlock() {
        val cases = mapOf(
            "<p>{{#if x}}hi{{/if}}</p>" to listOf("LOCKED"),
            "<p>{{#each v}}</p><p>{{this.d}}</p><p>{{/each}}</p>" to listOf("LOCKED", "PARAGRAPH", "LOCKED"),
            "<h2>{{^x}}none{{/x}}</h2><p>ok</p>" to listOf("LOCKED", "PARAGRAPH"),
            "<ul><li>a</li><li>{{else}}</li></ul>" to listOf("LOCKED"),
            "<ul><li><p>{{#x}}a</p></li></ul>" to listOf("LOCKED"),
            "<blockquote><p>{{ #if x }}</p></blockquote>" to listOf("LOCKED"),
            "<blockquote>{{/if}} inline</blockquote>" to listOf("LOCKED"),
            "<p><a href=\"{{link}}\" class=\"button\">{{#if a}}Go{{/if}}</a></p>" to listOf("LOCKED"),
            "<p>{{elsewhere}} is a field</p>" to listOf("PARAGRAPH"),
        )
        for ((html, expected) in cases) {
            val blocks = parseEmailContent(html)
            assertEquals(html, expected, kindsOf(blocks))
            assertEquals(html, serializeEmailContent(blocks))
        }
    }

    /**
     * Ruling C4: every seed the server stores, read from the repo. Each must round-trip byte
     * for byte, and the two `{{#each visits}}` seeds must come out with their list locked.
     */
    @Test fun everyStoredSeedRoundTripsByteForByte() {
        val files = seedsRoot().listFiles().orEmpty()
            .map { File(it, "content.html") }
            .filter { it.isFile }
            .sortedBy { it.parentFile.name }
        assertEquals(52, files.size)
        val loopSeeds = mutableListOf<String>()
        for (file in files) {
            val html = file.readText(Charsets.UTF_8)
            val blocks = parseEmailContent(html)
            assertEquals(file.parentFile.name, html, serializeEmailContent(blocks))
            if ("{{#each" in html) {
                loopSeeds += file.parentFile.name
                val list = blocks[1]
                assertTrue(file.parentFile.name, list is EmailBlock.LockedBlock)
                assertTrue(file.parentFile.name, (list as EmailBlock.LockedBlock).raw.startsWith("<ul>"))
                assertTrue(file.parentFile.name, "{{#each visits}}" in list.raw && "{{/each}}" in list.raw)
            }
        }
        assertEquals(listOf("assignment.assigned", "kincare.booking.confirm"), loopSeeds)
    }

    private fun kindsOf(blocks: List<EmailBlock>): List<String> = blocks.map { block ->
        when (block) {
            is EmailBlock.TextBlock -> block.kind.name + (block.number?.let { "#$it" } ?: "")
            is EmailBlock.ImageBlock -> "IMAGE"
            is EmailBlock.LockedBlock -> "LOCKED"
        }
    }

    /** Walk up from the test's working directory to the repo's seed folder. */
    private fun seedsRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "mytribe/seeds/notificationTemplates")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("Could not locate mytribe/seeds/notificationTemplates from ${System.getProperty("user.dir")}")
    }
}
