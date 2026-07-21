package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kinfolk
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper tests for the directory screens' tag wiring (2026-07-19 Tags port).
 *
 * Two seams are covered:
 *
 *  1. [kinfolkWithTags], the whole-object write. Android saves the entire Kinfolk,
 *     so a tag save that started from anything but the loaded doc would wipe every
 *     field it forgot. That is the exact bug that made `tags` mandatory on the
 *     Kotlin models in the first place.
 *
 *  2. The edit form's comma-separated bridge. [EditKinfolkUiState.tags] is still a
 *     CSV string and DirectoryViewModel still splits it on save, so the
 *     vocabulary-backed field has to round-trip through that shape exactly.
 */
class DirectoryTagWiringTest {

    // ── kinfolkWithTags: the whole-object write ─────────────────────────────

    private fun loaded(): Kinfolk = Kinfolk(
        id = "kf1",
        firstName = "Ada",
        lastName = "Byron",
        phoneNumber = "555-0100",
        email = "ada@example.com",
        gateCode = "1234",
        tags = listOf("VIP"),
    )

    @Test
    fun `writing tags carries every other field along untouched`() {
        val next = kinfolkWithTags(loaded(), listOf("VIP", "Slow pay"))
        assertEquals("kf1", next.id)
        assertEquals("Ada", next.firstName)
        assertEquals("Byron", next.lastName)
        assertEquals("555-0100", next.phoneNumber)
        assertEquals("ada@example.com", next.email)
        assertEquals("1234", next.gateCode)
        assertEquals(listOf("VIP", "Slow pay"), next.tagNames())
    }

    @Test
    fun `taking the last tag off genuinely clears the field`() {
        // An empty list is a real value, not a no-op: the field has to end up
        // empty on the doc, or a removed tag comes back on the next read.
        assertEquals(emptyList<String>(), kinfolkWithTags(loaded(), emptyList()).tagNames())
    }

    @Test
    fun `writing tags never mutates the kinfolk it was handed`() {
        val original = loaded()
        kinfolkWithTags(original, listOf("Changed"))
        assertEquals(listOf("VIP"), original.tagNames())
    }

    // ── The edit form's CSV bridge ──────────────────────────────────────────

    @Test
    fun `an empty field reads as no tags`() {
        assertEquals(emptyList<String>(), editTagsFromField(""))
        assertEquals(emptyList<String>(), editTagsFromField("   "))
        assertEquals(emptyList<String>(), editTagsFromField(" , , "))
    }

    @Test
    fun `the field splits on commas and trims each name`() {
        assertEquals(listOf("VIP", "Slow pay"), editTagsFromField("VIP,  Slow pay "))
    }

    @Test
    fun `a name's internal whitespace run collapses to one space`() {
        assertEquals(listOf("Slow pay"), editTagsFromField("Slow    pay"))
    }

    @Test
    fun `duplicates in a legacy free-text value collapse case-insensitively`() {
        // The old editor was raw text and could hold "vip, VIP". The vocabulary
        // treats those as ONE tag, so the field shows the first spelling.
        assertEquals(listOf("VIP"), editTagsFromField("VIP, vip,  ViP "))
    }

    @Test
    fun `names join back with the separator the form and view model expect`() {
        assertEquals("VIP, Slow pay", editTagsToField(listOf("VIP", "Slow pay")))
        assertEquals("", editTagsToField(emptyList()))
    }

    @Test
    fun `a name and the field round-trip through each other`() {
        val names = listOf("VIP", "Slow pay", "New puppy")
        assertEquals(names, editTagsFromField(editTagsToField(names)))
    }

    @Test
    fun `a comma inside a name becomes a space rather than splitting into two tags`() {
        // The form's state is a CSV and DirectoryViewModel splits it on save, so a
        // comma inside a name cannot survive. Turning it into a space keeps ONE
        // tag and shows the operator the result in the chip immediately, which
        // beats silently becoming two tags at save time. The real fix is
        // EditKinfolkUiState holding a List<String>; see DirectoryViewModel.
        assertEquals("VIP gold", editTagsToField(listOf("VIP, gold")))
        assertEquals(listOf("VIP gold"), editTagsFromField(editTagsToField(listOf("VIP, gold"))))
    }
}
