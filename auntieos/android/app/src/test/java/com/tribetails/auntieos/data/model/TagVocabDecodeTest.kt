package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parity guard for [decodeTagDefs] / [encodeTagDefs] against the React admin
 * decoder (auntieos-admin `src/api/settings.ts` decodeTagDefs). The rule there:
 * keep only well-formed `{ name, color: { token, css }, icon }` rows and DROP
 * anything malformed, never throw, because "a bad vocabulary must never take
 * down the whole settings read".
 *
 * The [TagColor.css] round-trip is the load-bearing case: Kotlin has no CSS
 * variables and paints chips from its own brand palette by [TagColor.token],
 * but it must write the `var(--color-*)` string back byte-identical or the
 * React admin stops painting.
 */
class TagVocabDecodeTest {

    /** A raw Firestore vocabulary row, each part independently corruptible. */
    private fun row(name: Any?, token: Any?, css: Any?, icon: Any?): Map<String, Any?> =
        mapOf("name" to name, "color" to mapOf("token" to token, "css" to css), "icon" to icon)

    private val vip = row("VIP", "teal", "var(--color-accent)", "⭐")

    // ── Happy path ───────────────────────────────────────────────────────────

    @Test fun `decodes a well-formed row keeping token and css verbatim`() {
        val out = decodeTagDefs(listOf(vip))
        assertEquals(1, out.size)
        assertEquals("VIP", out[0].name)
        assertEquals("teal", out[0].color.token)
        assertEquals("var(--color-accent)", out[0].color.css)
        assertEquals("⭐", out[0].icon)
    }

    @Test fun `an empty icon string is a valid row (no icon, not a dropped row)`() {
        val out = decodeTagDefs(listOf(row("Reactive", "coral", "var(--color-coral)", "")))
        assertEquals(1, out.size)
        assertEquals("", out[0].icon)
    }

    @Test fun `keeps the stored name untrimmed, exactly as React does`() {
        val out = decodeTagDefs(listOf(row("  VIP  ", "teal", "var(--color-accent)", "")))
        assertEquals("  VIP  ", out[0].name)
    }

    @Test fun `preserves row order`() {
        val out = decodeTagDefs(
            listOf(
                row("A", "teal", "var(--color-accent)", ""),
                row("B", "gold", "var(--color-warning)", ""),
                row("C", "green", "var(--color-success)", ""),
            )
        )
        assertEquals(listOf("A", "B", "C"), out.map { it.name })
    }

    // ── Drop rules (settings.ts:241-255), one test per guard ─────────────────

    @Test fun `a non-array raw decodes to empty`() {
        assertEquals(emptyList<TagDef>(), decodeTagDefs(null))
        assertEquals(emptyList<TagDef>(), decodeTagDefs("householdTags"))
        assertEquals(emptyList<TagDef>(), decodeTagDefs(42))
        assertEquals(emptyList<TagDef>(), decodeTagDefs(mapOf("name" to "VIP")))
    }

    @Test fun `drops a row that is not a map`() {
        assertEquals(listOf("VIP"), decodeTagDefs(listOf("VIP", null, 7, true, vip)).map { it.name })
    }

    @Test fun `drops a row whose name is missing, blank, or not a String`() {
        val raw = listOf(
            row(null, "teal", "var(--color-accent)", ""),
            row("", "teal", "var(--color-accent)", ""),
            row("   ", "teal", "var(--color-accent)", ""),
            row(true, "teal", "var(--color-accent)", ""),
            vip,
        )
        assertEquals(listOf("VIP"), decodeTagDefs(raw).map { it.name })
    }

    @Test fun `drops a row whose icon is not a String (null included)`() {
        val raw = listOf(
            row("NoIcon", "teal", "var(--color-accent)", null),
            row("BoolIcon", "teal", "var(--color-accent)", false),
            vip,
        )
        assertEquals(listOf("VIP"), decodeTagDefs(raw).map { it.name })
    }

    @Test fun `drops a row whose color is missing or not a map`() {
        val raw = listOf(
            mapOf("name" to "NoColor", "icon" to ""),
            mapOf("name" to "NullColor", "color" to null, "icon" to ""),
            mapOf("name" to "StringColor", "color" to "teal", "icon" to ""),
            vip,
        )
        assertEquals(listOf("VIP"), decodeTagDefs(raw).map { it.name })
    }

    @Test fun `drops a row whose color token or css is not a String`() {
        val raw = listOf(
            row("NoToken", null, "var(--color-accent)", ""),
            row("BoolToken", true, "var(--color-accent)", ""),
            row("NoCss", "teal", null, ""),
            row("NumCss", "teal", 3, ""),
            vip,
        )
        assertEquals(listOf("VIP"), decodeTagDefs(raw).map { it.name })
    }

    @Test fun `never throws on a fully hand-mangled vocabulary`() {
        val raw = listOf(null, 1, "x", emptyMap<String, Any>(), listOf("nested"), vip)
        assertEquals(1, decodeTagDefs(raw).size)
    }

    // ── Write side ───────────────────────────────────────────────────────────

    @Test fun `encodeTagDefs writes the token and css pair React reads`() {
        val encoded = encodeTagDefs(
            listOf(TagDef(name = "VIP", color = TagColor("teal", "var(--color-accent)"), icon = "⭐"))
        )
        assertEquals(1, encoded.size)
        assertEquals("VIP", encoded[0]["name"])
        assertEquals("⭐", encoded[0]["icon"])
        assertEquals(mapOf("token" to "teal", "css" to "var(--color-accent)"), encoded[0]["color"])
    }

    @Test fun `encode then decode round-trips a vocabulary unchanged`() {
        val defs = listOf(
            TagDef(name = "VIP", color = TagColor("teal", "var(--color-accent)"), icon = "⭐"),
            TagDef(name = "On meds", color = TagColor("gold", "var(--color-warning)"), icon = "💊"),
            TagDef(name = "Reactive", color = TagColor("coral", "var(--color-coral)"), icon = ""),
        )
        assertEquals(defs, decodeTagDefs(encodeTagDefs(defs)))
    }

    @Test fun `an unknown token survives the round trip (Kotlin never rewrites a color)`() {
        // A token Kotlin cannot paint is still persisted verbatim so React, which
        // may know it, keeps working. Kotlin falls back at PAINT time, not here.
        val defs = listOf(TagDef(name = "Future", color = TagColor("mauve", "var(--color-mauve)"), icon = ""))
        assertEquals(defs, decodeTagDefs(encodeTagDefs(defs)))
    }

    // ── Assignment lists on a profile (kinfolkProfile.ts / kinView.ts) ────────

    @Test fun `decodeTagNames keeps only String entries`() {
        assertEquals(listOf("VIP", "Monthly"), decodeTagNames(listOf("VIP", true, 7, null, "Monthly")))
    }

    @Test fun `decodeTagNames is empty for null, absent, and non-list values`() {
        assertEquals(emptyList<String>(), decodeTagNames(null))
        assertEquals(emptyList<String>(), decodeTagNames("VIP"))
        assertEquals(emptyList<String>(), decodeTagNames(mapOf("0" to "VIP")))
    }
}
