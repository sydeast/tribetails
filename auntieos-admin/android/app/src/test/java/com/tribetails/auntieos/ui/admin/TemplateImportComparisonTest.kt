package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.data.repository.decodeImportReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1936: a differing row shows the stored and the repo wording before the tick.
 * The same rules as the web admin's `channelComparison` and its screen test.
 */
class TemplateImportComparisonTest {

    private val smsDiff = TemplateRepository.ImportDifference(
        field = "text",
        label = "Text message",
        stored = "Sorry, we cannot make that visit.",
        repo = "{{business}}: we cannot make that visit.",
    )

    @Test
    fun `decoding keeps each channel's wordings`() {
        val decoded = decodeImportReport(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "templateId" to "kincare.request.declined",
                        "differsFromRepo" to true,
                        "channels" to listOf(
                            mapOf("channel" to "email", "outcome" to "create", "notes" to emptyList<String>()),
                            mapOf(
                                "channel" to "sms",
                                "outcome" to "skipped",
                                "notes" to listOf("The stored sms copy differs from the repo copy."),
                                "differences" to listOf(
                                    mapOf(
                                        "field" to "text",
                                        "label" to "Text message",
                                        "stored" to "Sorry, we cannot make that visit.",
                                        "repo" to "{{business}}: we cannot make that visit.",
                                    ),
                                    // Malformed entries are dropped, never guessed at.
                                    mapOf("field" to "text"),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val channels = decoded.rows[0].channels
        assertEquals(emptyList<TemplateRepository.ImportDifference>(), channels[0].differences)
        assertEquals(listOf(smsDiff), channels[1].differences)
    }

    @Test
    fun `a skipped or ticked channel shows both wordings, any other channel shows nothing`() {
        val skipped = TemplateRepository.ImportChannel("sms", "skipped", listOf("x"), listOf(smsDiff))
        assertEquals(ImportComparison.Shown(listOf(smsDiff)), importChannelComparison(skipped))
        assertEquals(ImportComparison.Shown(listOf(smsDiff)), importChannelComparison(skipped.copy(outcome = "overwrite")))
        assertNull(importChannelComparison(skipped.copy(outcome = "create")))
        assertNull(importChannelComparison(skipped.copy(outcome = "unchanged")))
        assertNull(importChannelComparison(skipped.copy(outcome = "blocked")))
    }

    @Test
    fun `a differing channel with no wordings says so rather than drawing a blank comparison`() {
        val older = TemplateRepository.ImportChannel("email", "skipped", listOf("x"))
        assertEquals(ImportComparison.Missing, importChannelComparison(older))
        assertEquals(
            "The two wordings could not be shown. Open this template in Templates to read your stored copy before you tick it.",
            IMPORT_COMPARISON_MISSING,
        )
    }

    @Test
    fun `an empty wording reads as Empty`() {
        assertEquals("Empty", wordingOrBlank("  "))
        assertEquals("Hi", wordingOrBlank("Hi"))
    }
}
