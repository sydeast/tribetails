package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the android tag vocabulary helpers (TagModels.kt), ported
 * from the React admin (auntieos-admin src/lib/tags/model.ts + assign.ts).
 * React is the reference implementation, and android and the Compose commonMain
 * twin are written independently and share no code, so these tests pin the wire
 * contract literally rather than deriving it. The palette test below is a
 * deliberate drift guard: the two Kotlin trees can silently disagree, and a
 * wrong css string breaks the React admin without breaking anything here.
 *
 * The wire models ([TagColor], [TagDef]) and the Firestore decode gate
 * ([decodeTagDefs] / [encodeTagDefs]) live in Models.kt and are covered by
 * their own tests; the round-trip test at the end of this file guards the seam.
 *
 * The two traps this file exists to hold down:
 *   1. `color` is a {token, css} PAIR and the css string is a literal CSS var
 *      reference React paints with. Android must round-trip it byte-for-byte.
 *   2. Every name comparison is case-INsensitive on the normalized name, while
 *      STORAGE keeps the casing as typed ("VIP" stays "VIP").
 */
class TagModelsTest {

    private fun vocab(): List<TagDef> = listOf(
        TagDef(name = "VIP", color = paletteColor("gold"), icon = "⭐"),
        TagDef(name = "Reactive", color = paletteColor("coral"), icon = "⚠️"),
        TagDef(name = "On meds", color = paletteColor("purple"), icon = ""),
    )

    // ── Palette: the drift guard between the two Kotlin trees and React ──────

    @Test
    fun `palette is the seven pinned tokens in order`() {
        assertEquals(
            listOf("teal", "orange", "pink", "purple", "coral", "gold", "green"),
            TAG_PALETTE.map { it.token },
        )
        assertEquals(TAG_PALETTE.map { it.token }, TAG_PALETTE_TOKENS)
    }

    @Test
    fun `palette css strings match the React literals byte for byte`() {
        // Verbatim from auntieos-admin src/lib/tags/model.ts:42-48. React paints
        // the chip from color.css, so a substituted hex or a reordered entry
        // silently breaks the admin surface.
        assertEquals(
            listOf(
                "var(--color-accent)",
                "var(--color-primary)",
                "var(--color-secondary)",
                "var(--color-tertiary)",
                "var(--color-coral)",
                "var(--color-warning)",
                "var(--color-success)",
            ),
            TAG_PALETTE.map { it.css },
        )
    }

    @Test
    fun `default tag color is the first palette entry teal`() {
        assertEquals("teal", DEFAULT_TAG_COLOR.token)
        assertEquals("var(--color-accent)", DEFAULT_TAG_COLOR.css)
        assertEquals(TAG_PALETTE.first(), DEFAULT_TAG_COLOR)
    }

    @Test
    fun `palette accessors hand out copies so a caller cannot repaint the palette`() {
        // TagColor carries `var` fields for Firebase's setter-based decode, so a
        // shared instance escaping into a TagDef would be an aliasing bug.
        paletteColor("gold").token = "hijacked"
        DEFAULT_TAG_COLOR.css = "hijacked"
        assertEquals("gold", paletteColor("gold").token)
        assertEquals("var(--color-accent)", DEFAULT_TAG_COLOR.css)
        assertEquals("var(--color-warning)", TAG_PALETTE[5].css)
    }

    @Test
    fun `max tag name length is the authoring surface cap of 40`() {
        assertEquals(40, MAX_TAG_NAME_LENGTH)
    }

    @Test
    fun `paletteColor looks up by exact case-sensitive token`() {
        assertEquals("var(--color-warning)", paletteColor("gold").css)
        assertEquals("var(--color-success)", paletteColor("green").css)
    }

    @Test
    fun `paletteColor falls back to the default for an unknown or wrong-case token`() {
        // Unlike names, the token lookup is NOT lowercased (model.ts:71).
        assertEquals(DEFAULT_TAG_COLOR, paletteColor("Gold"))
        assertEquals(DEFAULT_TAG_COLOR, paletteColor("chartreuse"))
        assertEquals(DEFAULT_TAG_COLOR, paletteColor(""))
    }

    // ── Scope ────────────────────────────────────────────────────────────────

    @Test
    fun `tag scope wire values are lowercase household and pet`() {
        assertEquals("household", TagScope.HOUSEHOLD.wire)
        assertEquals("pet", TagScope.PET.wire)
        assertEquals("householdTags", TagScope.HOUSEHOLD.vocabField)
        assertEquals("petTags", TagScope.PET.vocabField)
    }

    @Test
    fun `tag scope fromWire is case-insensitive and never throws`() {
        assertEquals(TagScope.PET, TagScope.fromWire("pet"))
        assertEquals(TagScope.PET, TagScope.fromWire(" PET "))
        assertEquals(TagScope.HOUSEHOLD, TagScope.fromWire("household"))
        assertEquals(TagScope.HOUSEHOLD, TagScope.fromWire(null))
        assertEquals(TagScope.HOUSEHOLD, TagScope.fromWire("garbage"))
    }

    // ── normalizeTagName ─────────────────────────────────────────────────────

    @Test
    fun `normalizeTagName trims and collapses internal whitespace runs`() {
        assertEquals("Needs meds", normalizeTagName("  Needs   meds  "))
        assertEquals("a b c", normalizeTagName("a\t\tb\n\nc"))
        assertEquals("", normalizeTagName("   "))
    }

    @Test
    fun `normalizeTagName does not change case`() {
        assertEquals("VIP", normalizeTagName(" VIP "))
        assertEquals("vip", normalizeTagName("vip"))
    }

    // ── resolveTag ───────────────────────────────────────────────────────────

    @Test
    fun `resolveTag hit returns the vocab canonical casing not the passed casing`() {
        val r = resolveTag("vip", vocab())
        assertEquals("VIP", r.name)
        assertEquals("gold", r.color?.token)
        assertEquals("var(--color-warning)", r.color?.css)
        assertEquals("⭐", r.icon)
    }

    @Test
    fun `resolveTag matches on the normalized name too`() {
        assertEquals("On meds", resolveTag("  on   MEDS ", vocab()).name)
    }

    @Test
    fun `resolveTag miss returns the passed name unchanged with null color and icon`() {
        val r = resolveTag("Fence jumper", vocab())
        assertEquals("Fence jumper", r.name)
        assertNull(r.color)
        assertNull(r.icon)
    }

    @Test
    fun `resolveTag hit with an empty icon returns empty string not null`() {
        // "" means "no icon" and is a HIT; null means "no vocab entry", a MISS.
        assertEquals("", resolveTag("On meds", vocab()).icon)
    }

    @Test
    fun `resolveTag never throws on an empty vocabulary`() {
        val r = resolveTag("anything", emptyList())
        assertEquals("anything", r.name)
        assertNull(r.color)
    }

    // ── addTag ───────────────────────────────────────────────────────────────

    @Test
    fun `addTag appends the normalized name keeping the typed casing`() {
        val next = addTag(vocab(), TagDef(name = "  Puppy  Pal ", color = paletteColor("teal"), icon = "🐾"))
        assertEquals(4, next.size)
        assertEquals("Puppy Pal", next.last().name)
        assertEquals("teal", next.last().color.token)
        assertEquals("🐾", next.last().icon)
    }

    @Test
    fun `addTag passes color and icon through unchanged`() {
        // The css string is never invented or rewritten on the Kotlin side.
        val next = addTag(emptyList(), TagDef(name = "Legacy", color = TagColor("chartreuse", "var(--legacy)"), icon = ""))
        assertEquals("chartreuse", next.single().color.token)
        assertEquals("var(--legacy)", next.single().color.css)
        assertEquals("", next.single().icon)
    }

    @Test
    fun `addTag does not mutate the input list`() {
        val original = vocab()
        addTag(original, TagDef(name = "New", color = DEFAULT_TAG_COLOR, icon = ""))
        assertEquals(3, original.size)
    }

    @Test
    fun `addTag rejects a blank name with the exact React copy`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            addTag(vocab(), TagDef(name = "   ", color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name is required.", e.message)
    }

    @Test
    fun `addTag rejects a name over 40 characters with the exact React copy`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            addTag(vocab(), TagDef(name = "x".repeat(41), color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name must be 40 characters or fewer.", e.message)
    }

    @Test
    fun `addTag accepts a name of exactly 40 characters`() {
        val name = "x".repeat(40)
        assertEquals(name, addTag(emptyList(), TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = "")).single().name)
    }

    @Test
    fun `addTag rejects a case-insensitive duplicate quoting the normalized name`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            addTag(vocab(), TagDef(name = " vip ", color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A \"vip\" tag already exists.", e.message)
    }

    @Test
    fun `addTag checks blank before length`() {
        // Whitespace normalizes away, so an all-whitespace name over the cap
        // reports blank and the length check never sees it.
        val e = assertThrows(IllegalArgumentException::class.java) {
            addTag(vocab(), TagDef(name = " ".repeat(60), color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name is required.", e.message)
    }

    // ── removeTag / editTag ──────────────────────────────────────────────────

    @Test
    fun `removeTag drops the entry case-insensitively`() {
        assertEquals(listOf("Reactive", "On meds"), removeTag(vocab(), "  vIp ").map { it.name })
    }

    @Test
    fun `removeTag on an unknown name returns the list unchanged`() {
        assertEquals(3, removeTag(vocab(), "nope").size)
    }

    @Test
    fun `editTag changes color and icon but never the name`() {
        val hit = editTag(vocab(), "vip", color = paletteColor("pink"), icon = "🔥").first { it.name == "VIP" }
        assertEquals("VIP", hit.name)
        assertEquals("pink", hit.color.token)
        assertEquals("var(--color-secondary)", hit.color.css)
        assertEquals("🔥", hit.icon)
    }

    @Test
    fun `editTag leaves an omitted patch field at its existing value`() {
        val onlyIcon = editTag(vocab(), "VIP", icon = "🔥").first { it.name == "VIP" }
        assertEquals("gold", onlyIcon.color.token)
        assertEquals("🔥", onlyIcon.icon)

        val onlyColor = editTag(vocab(), "VIP", color = paletteColor("green")).first { it.name == "VIP" }
        assertEquals("green", onlyColor.color.token)
        assertEquals("⭐", onlyColor.icon)
    }

    @Test
    fun `editTag can clear an icon to empty string`() {
        // "" is a real value ("No emoji"), distinct from "leave it alone".
        assertEquals("", editTag(vocab(), "VIP", icon = "").first { it.name == "VIP" }.icon)
    }

    @Test
    fun `editTag returns a new list and leaves unmatched entries identical`() {
        val original = vocab()
        val edited = editTag(original, "VIP", icon = "🔥")
        assertEquals("⭐", original.first().icon)
        assertSame(original[1], edited[1])
    }

    // ── suggestTags ──────────────────────────────────────────────────────────

    @Test
    fun `suggestTags with a blank query returns the whole unassigned pool in vocab order`() {
        assertEquals(listOf("VIP", "Reactive", "On meds"), suggestTags("", vocab(), emptyList()).map { it.name })
        assertEquals(listOf("VIP", "Reactive", "On meds"), suggestTags("   ", vocab(), emptyList()).map { it.name })
    }

    @Test
    fun `suggestTags excludes already-assigned names case-insensitively`() {
        assertEquals(listOf("Reactive", "On meds"), suggestTags("", vocab(), listOf(" vip ")).map { it.name })
    }

    @Test
    fun `suggestTags ranks prefix matches before substring matches`() {
        val v = listOf(
            TagDef(name = "Senior", color = DEFAULT_TAG_COLOR, icon = ""),
            TagDef(name = "Very senior", color = DEFAULT_TAG_COLOR, icon = ""),
            TagDef(name = "Sensitive", color = DEFAULT_TAG_COLOR, icon = ""),
        )
        // "sen" prefixes Senior and Sensitive (in vocab order), then the
        // contains-only match Very senior.
        assertEquals(listOf("Senior", "Sensitive", "Very senior"), suggestTags("sen", v, emptyList()).map { it.name })
    }

    @Test
    fun `suggestTags never lists a prefix match twice`() {
        val v = listOf(TagDef(name = "Reactive", color = DEFAULT_TAG_COLOR, icon = ""))
        assertEquals(1, suggestTags("rea", v, emptyList()).size)
    }

    @Test
    fun `suggestTags matches case-insensitively on the normalized query`() {
        assertEquals(listOf("On meds"), suggestTags("  ON  ", vocab(), emptyList()).map { it.name })
    }

    @Test
    fun `suggestTags with no match returns empty`() {
        assertTrue(suggestTags("zzz", vocab(), emptyList()).isEmpty())
    }

    // ── addAssigned / removeAssigned ─────────────────────────────────────────

    @Test
    fun `addAssigned normalizes and appends at the end`() {
        assertEquals(listOf("VIP", "Puppy Pal"), addAssigned(listOf("VIP"), "  Puppy   Pal "))
    }

    @Test
    fun `addAssigned stores the name as typed without lowercasing`() {
        assertEquals(listOf("VIP"), addAssigned(emptyList(), "VIP"))
    }

    @Test
    fun `addAssigned is a no-op for a blank name`() {
        val already = listOf("VIP")
        assertEquals(already, addAssigned(already, "   "))
        assertEquals(already, addAssigned(already, ""))
    }

    @Test
    fun `addAssigned dedupes case-insensitively`() {
        assertEquals(listOf("VIP"), addAssigned(listOf("VIP"), "vip"))
        assertEquals(listOf("VIP"), addAssigned(listOf("VIP"), " ViP "))
    }

    @Test
    fun `removeAssigned filters case-insensitively preserving order`() {
        assertEquals(listOf("VIP", "On meds"), removeAssigned(listOf("VIP", "Reactive", "On meds"), " reactive "))
    }

    @Test
    fun `removeAssigned on an unknown name returns the same contents`() {
        assertEquals(listOf("VIP"), removeAssigned(listOf("VIP"), "nope"))
    }

    // ── canonicalTagName ─────────────────────────────────────────────────────

    @Test
    fun `canonicalTagName prefers the vocab casing on a hit`() {
        assertEquals("VIP", canonicalTagName("vip", vocab()))
        assertEquals("On meds", canonicalTagName("  ON MEDS ", vocab()))
    }

    @Test
    fun `canonicalTagName falls back to the normalized typed name on a miss`() {
        assertEquals("Fence jumper", canonicalTagName("  Fence   jumper  ", vocab()))
    }

    // ── Seam with the Models.kt wire codec ───────────────────────────────────

    @Test
    fun `a vocabulary edited here survives the Firestore encode-decode round trip`() {
        // The whole point of carrying `css`: an android edit must leave the
        // React admin painting exactly the same chips.
        val added = addTag(vocab(), TagDef(name = "Puppy Pal", color = paletteColor("teal"), icon = "🐾"))
        val edited = editTag(added, "VIP", color = paletteColor("green"))
        val back = decodeTagDefs(encodeTagDefs(edited))

        assertEquals(edited, back)
        assertEquals(
            listOf("var(--color-success)", "var(--color-coral)", "var(--color-tertiary)", "var(--color-accent)"),
            back.map { it.color.css },
        )
        assertEquals(listOf("VIP", "Reactive", "On meds", "Puppy Pal"), back.map { it.name })
    }

    @Test
    fun `an unknown token round-trips unchanged and paints from the default`() {
        val stored = decodeTagDefs(encodeTagDefs(listOf(TagDef(name = "Legacy", color = TagColor("chartreuse", "var(--legacy)"), icon = ""))))
        assertEquals("chartreuse", stored.single().color.token)
        assertEquals("var(--legacy)", stored.single().color.css)
        // Painting falls back at render time; the stored value is never rewritten.
        assertEquals(DEFAULT_TAG_COLOR, paletteColor(stored.single().color.token))
    }
}
