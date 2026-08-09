package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android twin of `auntieos-admin/src/lib/mergeFields.test.ts`, vector for
 * vector. Two platforms answering "which merge fields will arrive blank"
 * differently is worse than neither answering it, so the cases are deliberately
 * the same cases rather than an independently invented set.
 */
class MergeFieldsTest {

    @Test
    fun `finds handlebars tokens and reports their spans`() {
        assertEquals(
            listOf(
                MergeField(token = "{{kinfolkName}}", key = "kinfolkName", start = 3, end = 18),
                MergeField(token = "{{ link }}", key = "link", start = 24, end = 34),
            ),
            findMergeFields("Hi {{kinfolkName}}, see {{ link }}."),
        )
    }

    @Test
    fun `returns an empty list for a body with no tokens`() {
        assertEquals(emptyList<MergeField>(), findMergeFields("No fields here."))
    }

    @Test
    fun `ignores a block helper, which the senders scrub rather than resolve`() {
        assertEquals(emptyList<MergeField>(), findMergeFields("{{#if paid}}Thanks{{/if}} {{> footer}}"))
    }

    @Test
    fun `reads a dotted path as one key`() {
        assertEquals(
            listOf(MergeField(token = "{{invoice.number}}", key = "invoice.number", start = 0, end = 18)),
            findMergeFields("{{invoice.number}}"),
        )
    }

    @Test
    fun `marks a token with no sample binding as unresolved`() {
        assertEquals(
            listOf(
                PreviewSegment.Text("Hi "),
                PreviewSegment.Field(key = "kinfolkName", value = null),
                PreviewSegment.Text("!"),
            ),
            renderPreview("Hi {{kinfolkName}}!", emptyMap()),
        )
    }

    @Test
    fun `substitutes a bound token`() {
        assertEquals(
            PreviewSegment.Field(key = "kinfolkName", value = "Sandy"),
            renderPreview("Hi {{kinfolkName}}!", mapOf("kinfolkName" to "Sandy"))[1],
        )
    }

    @Test
    fun `keeps an empty-string binding distinct from an absent one`() {
        assertEquals(
            PreviewSegment.Field(key = "a", value = ""),
            renderPreview("{{a}}", mapOf("a" to ""))[0],
        )
        assertEquals(
            PreviewSegment.Field(key = "a", value = null),
            renderPreview("{{a}}", emptyMap())[0],
        )
    }

    @Test
    fun `returns the whole body as one text segment when nothing merges`() {
        assertEquals(listOf(PreviewSegment.Text("Plain copy.")), renderPreview("Plain copy.", emptyMap()))
    }

    @Test
    fun `returns nothing at all for an empty body`() {
        assertEquals(emptyList<PreviewSegment>(), renderPreview("", emptyMap()))
    }

    @Test
    fun `names a repeated unbound key once, so the count matches the names`() {
        assertEquals(
            listOf("a"),
            unresolvedKeys(renderPreview("{{a}} {{b}} {{a}}", mapOf("b" to "bound"))),
        )
    }

    @Test
    fun `names each unbound key once, in first-seen order`() {
        assertEquals(
            listOf("link", "code"),
            unresolvedKeys(renderPreview("{{link}} {{code}} {{link}}", emptyMap())),
        )
    }

    @Test
    fun `names nothing when every token binds`() {
        assertEquals(emptyList<String>(), unresolvedKeys(renderPreview("{{a}}", mapOf("a" to "x"))))
    }

    @Test
    fun `substitution fills a bound token and leaves an unbound one in braces`() {
        assertEquals(
            "Hi Sandy Wren, see {{link}}.",
            substituteMergeFields("Hi {{kinfolkName}}, see {{link}}.", ENRICHABLE_SAMPLE),
        )
    }

    @Test
    fun `substitution leaves copy with no merge fields exactly as written`() {
        assertEquals(
            "See their account here: []",
            substituteMergeFields("See their account here: []", ENRICHABLE_SAMPLE),
        )
    }

    @Test
    fun `substitution against an empty sample changes nothing, which is the broadcast case`() {
        assertEquals("Hi {{kinfolkName}}", substituteMergeFields("Hi {{kinfolkName}}", emptyMap()))
    }

    @Test
    fun `enrichable sample covers exactly the twelve tokens the enricher hydrates`() {
        assertEquals(
            listOf(
                "amount",
                "bookingDate",
                "bookingTime",
                "displayName",
                "dueDate",
                "email",
                "invoiceNumber",
                "kinName",
                "kinfolkEmail",
                "kinfolkName",
                "notes",
                "serviceType",
            ),
            ENRICHABLE_SAMPLE.keys.sorted(),
        )
    }

    @Test
    fun `enrichable sample binds every one of them to a non-blank value`() {
        ENRICHABLE_SAMPLE.forEach { (key, value) ->
            assertTrue("$key has no sample value", value.isNotBlank())
        }
    }

    @Test
    fun `leaves an emitter-supplied token such as link unbound`() {
        assertNull(ENRICHABLE_SAMPLE["link"])
    }

    @Test
    fun `warning text names one field in the singular`() {
        assertEquals(
            "1 merge field has no sample value: link",
            unresolvedWarning(listOf("link")),
        )
    }

    @Test
    fun `warning text pluralizes and lists every distinct key`() {
        assertEquals(
            "2 merge fields have no sample value: link, code",
            unresolvedWarning(listOf("link", "code")),
        )
    }

    @Test
    fun `there is no warning text when nothing is unresolved`() {
        assertNull(unresolvedWarning(emptyList()))
    }
}
