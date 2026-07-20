package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Pins the tag vocabulary model + pure helpers against the React admin
 * (auntieos-admin `src/lib/tags/model.ts` and `src/lib/tags/assign.ts`), which
 * is the authoring surface. Both surfaces read and write the SAME Firestore
 * docs, so any drift here shows up as a tag that renders one way in the React
 * admin and another way on web / desktop, or worse, a vocabulary React can no
 * longer paint.
 *
 * Two things these tests exist to catch above all:
 *  - CASE. Every name comparison in the React tag layer is case-insensitive on
 *    the normalized name, while STORAGE keeps the casing as typed. Getting one
 *    of those two halves wrong lets "vip" sit beside "VIP" as separate tags.
 *  - THE `css` STRING. React paints a chip with `color.css`, a literal CSS var
 *    reference ("var(--color-accent)"). Kotlin cannot use it and paints from
 *    its own brand palette by `token`, so the temptation is to drop `css` or
 *    swap in a hex. Either one breaks the React admin the next time Kotlin
 *    saves the vocabulary. It must round-trip byte-for-byte.
 */
class TagModelsTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun vocab(vararg names: String): List<TagDef> =
        names.map { TagDef(name = it, color = DEFAULT_TAG_COLOR, icon = "") }

    // ---- palette: order and exact wire values ----

    @Test
    fun palette_hasSevenEntriesInReactOrder() {
        assertEquals(7, TAG_PALETTE.size)
        assertEquals(
            listOf("teal", "orange", "pink", "purple", "coral", "gold", "green"),
            TAG_PALETTE.map { it.token },
        )
    }

    @Test
    fun palette_cssStringsMatchReactVerbatim() {
        // These are literal CSS var references from the React Den token set.
        // Kotlin never parses or paints them, it only persists them unchanged.
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
    fun defaultTagColor_isTealAndIsFirstPaletteEntry() {
        assertEquals("teal", DEFAULT_TAG_COLOR.token)
        assertEquals("var(--color-accent)", DEFAULT_TAG_COLOR.css)
        // Order is load-bearing: the first palette entry IS the default.
        assertEquals(TAG_PALETTE.first(), DEFAULT_TAG_COLOR)
    }

    @Test
    fun maxTagNameLength_is40() {
        // 40 matches the React authoring surface. The backend independently
        // accepts 60, so 40 can never trip it.
        assertEquals(40, MAX_TAG_NAME_LENGTH)
    }

    // ---- paletteColor: EXACT-match, case-SENSITIVE on the token ----

    @Test
    fun paletteColor_findsEachTokenExactly() {
        TAG_PALETTE.forEach { entry ->
            assertEquals(entry, paletteColor(entry.token))
        }
    }

    @Test
    fun paletteColor_isCaseSensitiveUnlikeNames() {
        // Names are compared case-insensitively; tokens are NOT.
        assertEquals(DEFAULT_TAG_COLOR, paletteColor("TEAL"))
        assertEquals(DEFAULT_TAG_COLOR, paletteColor("Gold"))
    }

    @Test
    fun paletteColor_unknownTokenFallsBackToDefaultAndNeverThrows() {
        assertEquals(DEFAULT_TAG_COLOR, paletteColor("chartreuse"))
        assertEquals(DEFAULT_TAG_COLOR, paletteColor(""))
    }

    // ---- normalizeTagName ----

    @Test
    fun normalizeTagName_trimsEnds() {
        assertEquals("VIP", normalizeTagName("  VIP  "))
    }

    @Test
    fun normalizeTagName_collapsesInternalWhitespaceRuns() {
        assertEquals("On meds", normalizeTagName("On    meds"))
        assertEquals("On meds", normalizeTagName("On\tmeds"))
        assertEquals("On meds", normalizeTagName("On\n\nmeds"))
        assertEquals("a b c", normalizeTagName("  a   b \t c  "))
    }

    @Test
    fun normalizeTagName_blankBecomesEmpty() {
        assertEquals("", normalizeTagName(""))
        assertEquals("", normalizeTagName("   \t\n "))
    }

    @Test
    fun normalizeTagName_doesNotChangeCase() {
        // Only COMPARISON lowercases. Storage keeps the casing as typed.
        assertEquals("VIP", normalizeTagName("VIP"))
        assertEquals("vIp", normalizeTagName("vIp"))
    }

    // ---- resolveTag ----

    @Test
    fun resolveTag_hitReturnsVocabCanonicalCasingNotTheQueryCasing() {
        val v = listOf(TagDef(name = "VIP", color = paletteColor("gold"), icon = "⭐"))
        val resolved = resolveTag("vip", v)
        assertEquals("VIP", resolved.name)
        assertEquals("gold", resolved.color?.token)
        assertEquals("⭐", resolved.icon)
    }

    @Test
    fun resolveTag_matchesOnTheNormalizedName() {
        val v = listOf(TagDef(name = "On meds", color = DEFAULT_TAG_COLOR, icon = "💊"))
        assertEquals("On meds", resolveTag("  on    MEDS  ", v).name)
    }

    @Test
    fun resolveTag_missReturnsPassedNameUnchangedWithNullColorAndIcon() {
        val resolved = resolveTag("  Free Form  ", vocab("VIP"))
        // A miss renders a neutral chip, so the name comes back exactly as passed.
        assertEquals("  Free Form  ", resolved.name)
        assertNull(resolved.color)
        assertNull(resolved.icon)
    }

    @Test
    fun resolveTag_hitWithNoIconReturnsEmptyStringNotNull() {
        // '' means "no icon", null means "not in the vocabulary". Different things.
        val resolved = resolveTag("VIP", vocab("VIP"))
        assertEquals("", resolved.icon)
    }

    @Test
    fun resolveTag_emptyVocabIsAMissAndNeverThrows() {
        val resolved = resolveTag("VIP", emptyList())
        assertEquals("VIP", resolved.name)
        assertNull(resolved.color)
    }

    @Test
    fun resolveTag_roundTripsTheCssStringUnchanged() {
        // The whole point: Kotlin hands React back the same paint value.
        val gold = paletteColor("gold")
        val resolved = resolveTag("vip", listOf(TagDef(name = "VIP", color = gold, icon = "")))
        assertEquals("var(--color-warning)", resolved.color?.css)
    }

    @Test
    fun resolveTag_roundTripsAnUnknownTokensCssUnchanged() {
        // A color written by a newer React build: Kotlin must not rewrite it.
        val future = TagColor(token = "lilac", css = "var(--color-lilac)")
        val resolved = resolveTag("Soon", listOf(TagDef(name = "Soon", color = future, icon = "")))
        assertEquals("lilac", resolved.color?.token)
        assertEquals("var(--color-lilac)", resolved.color?.css)
    }

    // ---- addTag ----

    @Test
    fun addTag_appendsAtTheEnd() {
        val next = addTag(vocab("VIP"), TagDef(name = "Reactive", color = DEFAULT_TAG_COLOR, icon = "⚠️"))
        assertEquals(listOf("VIP", "Reactive"), next.map { it.name })
    }

    @Test
    fun addTag_storesTheNormalizedNameKeepingItsCasing() {
        val next = addTag(emptyList(), TagDef(name = "  On    MEDS  ", color = DEFAULT_TAG_COLOR, icon = ""))
        assertEquals("On MEDS", next.single().name)
    }

    @Test
    fun addTag_keepsColorAndIconAsGiven() {
        val next = addTag(emptyList(), TagDef(name = "VIP", color = paletteColor("pink"), icon = "⭐"))
        assertEquals("pink", next.single().color.token)
        assertEquals("var(--color-secondary)", next.single().color.css)
        assertEquals("⭐", next.single().icon)
    }

    @Test
    fun addTag_doesNotMutateTheInputList() {
        val original = vocab("VIP")
        addTag(original, TagDef(name = "Reactive", color = DEFAULT_TAG_COLOR, icon = ""))
        assertEquals(1, original.size)
    }

    @Test
    fun addTag_blankNameThrowsTheExactCopy() {
        val e = assertFailsWith<IllegalArgumentException> {
            addTag(emptyList(), TagDef(name = "   ", color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name is required.", e.message)
    }

    @Test
    fun addTag_overTheCapThrowsTheExactCopy() {
        val e = assertFailsWith<IllegalArgumentException> {
            addTag(emptyList(), TagDef(name = "x".repeat(41), color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name must be 40 characters or fewer.", e.message)
    }

    @Test
    fun addTag_exactlyAtTheCapIsAccepted() {
        val name = "x".repeat(40)
        assertEquals(name, addTag(emptyList(), TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = "")).single().name)
    }

    @Test
    fun addTag_lengthIsCheckedAfterNormalization() {
        // 40 x's padded with whitespace normalizes back to 40 and must pass.
        val padded = "  " + "x".repeat(40) + "  "
        assertEquals(40, addTag(emptyList(), TagDef(name = padded, color = DEFAULT_TAG_COLOR, icon = "")).single().name.length)
    }

    @Test
    fun addTag_duplicateIsRejectedCaseInsensitively() {
        val e = assertFailsWith<IllegalArgumentException> {
            addTag(vocab("VIP"), TagDef(name = "vip", color = DEFAULT_TAG_COLOR, icon = ""))
        }
        // The NORMALIZED name goes inside straight double quotes.
        assertEquals("A \"vip\" tag already exists.", e.message)
    }

    @Test
    fun addTag_duplicateIsRejectedAcrossWhitespaceShape() {
        assertFailsWith<IllegalArgumentException> {
            addTag(vocab("On meds"), TagDef(name = "  on    meds ", color = DEFAULT_TAG_COLOR, icon = ""))
        }
    }

    @Test
    fun addTag_checksBlankBeforeLengthBeforeDuplicate() {
        // A blank name that is also over the cap reports blank first.
        val e = assertFailsWith<IllegalArgumentException> {
            addTag(emptyList(), TagDef(name = " ".repeat(50), color = DEFAULT_TAG_COLOR, icon = ""))
        }
        assertEquals("A tag name is required.", e.message)
    }

    // ---- removeTag ----

    @Test
    fun removeTag_dropsTheEntryCaseInsensitivelyAndKeepsOrder() {
        val next = removeTag(vocab("VIP", "Reactive", "On meds"), "reactive")
        assertEquals(listOf("VIP", "On meds"), next.map { it.name })
    }

    @Test
    fun removeTag_matchesOnTheNormalizedName() {
        assertTrue(removeTag(vocab("On meds"), "  ON    MEDS ").isEmpty())
    }

    @Test
    fun removeTag_unknownNameIsANoOp() {
        assertEquals(listOf("VIP"), removeTag(vocab("VIP"), "nope").map { it.name })
    }

    @Test
    fun removeTag_doesNotMutateTheInputList() {
        val original = vocab("VIP")
        removeTag(original, "VIP")
        assertEquals(1, original.size)
    }

    // ---- editTag ----

    @Test
    fun editTag_changesColorAndLeavesTheNameAlone() {
        val next = editTag(vocab("VIP"), "vip", color = paletteColor("gold"))
        assertEquals("VIP", next.single().name)
        assertEquals("gold", next.single().color.token)
        assertEquals("var(--color-warning)", next.single().color.css)
    }

    @Test
    fun editTag_changesIconOnly() {
        val next = editTag(listOf(TagDef(name = "VIP", color = paletteColor("gold"), icon = "")), "VIP", icon = "⭐")
        assertEquals("⭐", next.single().icon)
        assertEquals("gold", next.single().color.token)
    }

    @Test
    fun editTag_clearingTheIconToEmptyStringIsAnEdit_notANoOp() {
        val next = editTag(listOf(TagDef(name = "VIP", color = DEFAULT_TAG_COLOR, icon = "⭐")), "VIP", icon = "")
        assertEquals("", next.single().icon)
    }

    @Test
    fun editTag_omittedFieldsLeaveTheExistingValues() {
        val before = listOf(TagDef(name = "VIP", color = paletteColor("pink"), icon = "⭐"))
        val next = editTag(before, "VIP")
        assertEquals(before, next)
    }

    @Test
    fun editTag_leavesOtherEntriesUntouchedAndKeepsOrder() {
        val next = editTag(vocab("VIP", "Reactive"), "Reactive", color = paletteColor("coral"))
        assertEquals(listOf("VIP", "Reactive"), next.map { it.name })
        assertEquals("teal", next[0].color.token)
        assertEquals("coral", next[1].color.token)
    }

    @Test
    fun editTag_unknownNameIsANoOp() {
        val before = vocab("VIP")
        assertEquals(before, editTag(before, "nope", color = paletteColor("gold")))
    }

    // ---- suggestTags ----

    @Test
    fun suggestTags_blankQueryReturnsTheWholeUnassignedPoolInVocabOrder() {
        val v = vocab("VIP", "Reactive", "On meds")
        assertEquals(listOf("VIP", "Reactive", "On meds"), suggestTags("", v, emptyList()).map { it.name })
        assertEquals(listOf("VIP", "Reactive", "On meds"), suggestTags("   ", v, emptyList()).map { it.name })
    }

    @Test
    fun suggestTags_excludesAlreadyAssignedCaseInsensitively() {
        val v = vocab("VIP", "Reactive")
        assertEquals(listOf("Reactive"), suggestTags("", v, listOf("vip")).map { it.name })
    }

    @Test
    fun suggestTags_excludesAssignedAcrossWhitespaceShape() {
        val v = vocab("On meds", "VIP")
        assertEquals(listOf("VIP"), suggestTags("", v, listOf("  ON   MEDS ")).map { it.name })
    }

    @Test
    fun suggestTags_prefixMatchesRankBeforeSubstringMatches() {
        // "re" prefixes Reactive and is a substring of "Senior care" (in "care").
        // Reactive must come first even though it sits later in the vocabulary.
        val v = vocab("Senior care", "Reactive", "Barrier")
        assertEquals(listOf("Reactive", "Senior care"), suggestTags("re", v, emptyList()).map { it.name })
    }

    @Test
    fun suggestTags_prefixMatchNeverAlsoAppearsInTheContainsRun() {
        val v = vocab("Meds", "On meds")
        val out = suggestTags("me", v, emptyList()).map { it.name }
        assertEquals(listOf("Meds", "On meds"), out)
        assertEquals(out.size, out.toSet().size)
    }

    @Test
    fun suggestTags_isCaseInsensitiveOnBothSides() {
        val v = vocab("VIP")
        assertEquals(listOf("VIP"), suggestTags("vi", v, emptyList()).map { it.name })
        assertEquals(listOf("VIP"), suggestTags("VI", v, emptyList()).map { it.name })
    }

    @Test
    fun suggestTags_queryIsNormalizedBeforeMatching() {
        val v = vocab("On meds")
        assertEquals(listOf("On meds"), suggestTags("  on    m ", v, emptyList()).map { it.name })
    }

    @Test
    fun suggestTags_noMatchReturnsEmpty() {
        assertTrue(suggestTags("zzz", vocab("VIP"), emptyList()).isEmpty())
    }

    @Test
    fun suggestTags_preservesVocabOrderWithinEachRun() {
        val v = vocab("Care A", "Care B", "Extra care")
        assertEquals(
            listOf("Care A", "Care B", "Extra care"),
            suggestTags("care", v, emptyList()).map { it.name },
        )
    }

    @Test
    fun suggestTags_doesNotMutateItsInputs() {
        val v = vocab("VIP", "Reactive")
        val already = listOf("vip")
        suggestTags("re", v, already)
        assertEquals(2, v.size)
        assertEquals(1, already.size)
    }

    @Test
    fun suggestTags_returnsTheVocabEntriesThemselvesSoColorSurvives() {
        val entry = TagDef(name = "VIP", color = paletteColor("gold"), icon = "⭐")
        assertSame(entry, suggestTags("vi", listOf(entry), emptyList()).single())
    }

    // ---- Firestore wire shape / crash safety ----

    @Test
    fun tagDef_serializesWithBothColorFields() {
        val encoded = json.encodeToString(TagDef.serializer(), TagDef(name = "VIP", color = paletteColor("gold"), icon = "⭐"))
        assertTrue(encoded.contains("\"token\":\"gold\""), encoded)
        assertTrue(encoded.contains("\"css\":\"var(--color-warning)\""), encoded)
        assertTrue(encoded.contains("\"icon\":\"⭐\""), encoded)
    }

    @Test
    fun tagDef_decodesADocWithEveryFieldMissing() {
        // Crash safety: an older or partial doc must not take down the read.
        val decoded = json.decodeFromString(TagDef.serializer(), "{}")
        assertEquals("", decoded.name)
        assertEquals("", decoded.icon)
        assertEquals(DEFAULT_TAG_COLOR, decoded.color)
    }

    @Test
    fun tagDef_decodesADocWithAPartialColor() {
        val decoded = json.decodeFromString(TagDef.serializer(), """{"name":"VIP","color":{"token":"gold"}}""")
        assertEquals("gold", decoded.color.token)
        assertEquals("", decoded.color.css)
    }

    @Test
    fun tagDef_survivesAnUnknownFieldFromANewerBuild() {
        val decoded = json.decodeFromString(
            TagDef.serializer(),
            """{"name":"VIP","color":{"token":"gold","css":"var(--color-warning)"},"icon":"","iconType":"emoji"}""",
        )
        assertEquals("VIP", decoded.name)
    }

    @Test
    fun tagDef_roundTripsThroughJsonUnchanged() {
        val before = TagDef(name = "On meds", color = paletteColor("coral"), icon = "💊")
        val after = json.decodeFromString(TagDef.serializer(), json.encodeToString(TagDef.serializer(), before))
        assertEquals(before, after)
    }
}
