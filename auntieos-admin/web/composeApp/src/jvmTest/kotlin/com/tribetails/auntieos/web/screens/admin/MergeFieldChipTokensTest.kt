package com.tribetails.auntieos.web.screens.admin

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #2487 (owner report): "templates need placeholders that actually work". The
 * Template Bank's merge-field chips insert a token into a template that is
 * saved to the same `emailTemplates` store every notice renders from. Each
 * chip must therefore be a token a send fills: one the server's enricher
 * hydrates (`ENRICHABLE`, read off disk here so the two cannot drift), or
 * `{{link}}`, which the channel trigger fills for every notice.
 */
class MergeFieldChipTokensTest {

    private fun repoRoot(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            if (File(dir, "mytribe").isDirectory && File(dir, "auntieos-admin").isDirectory) return dir
            dir = dir.parentFile
        }
        throw AssertionError("Could not find the repo root above ${File("").absolutePath}; this test reads the server source.")
    }

    private val enrichable: Set<String> by lazy {
        val f = File(repoRoot(), "mytribe/functions/src/notifications/enrichTemplateData.ts")
        assertTrue(f.isFile, "The server enricher is missing at ${f.absolutePath}. Fix the path; do not delete this test.")
        val src = f.readText()
        val start = src.indexOf("const ENRICHABLE")
        val end = src.indexOf("]);", start)
        assertTrue(start > -1 && end > start, "Could not find the server ENRICHABLE set")
        Regex("""'([A-Za-z]+)'""").findAll(src.substring(start, end)).map { it.groupValues[1] }.toSet()
    }

    @Test
    fun everyChipIsATokenASendFills() {
        assertTrue(enrichable.size > 5, "Parsed too few names out of ENRICHABLE: $enrichable")
        val filled = enrichable + "link"
        val unfilled = MERGE_FIELD_CHIP_TOKENS
            .map { it.removePrefix("{{").removeSuffix("}}") }
            .filterNot { it in filled }
        assertTrue(unfilled.isEmpty(), "These chips insert a merge field no send fills: $unfilled")
    }

    @Test
    fun theChipsOfferTheLinkToTheNoticesItem() {
        assertTrue("{{link}}" in MERGE_FIELD_CHIP_TOKENS)
    }
}
