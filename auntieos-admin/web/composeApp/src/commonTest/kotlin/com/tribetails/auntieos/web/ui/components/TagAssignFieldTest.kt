package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.suggestTags
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pins the assign field's pure decisions against the React admin
 * (auntieos-admin `src/components/TagAssignField.tsx`, whose transforms live in
 * `src/lib/tags/assign.ts`).
 *
 * The suggestion ORDER contract and the CANONICAL-CASING rule are the two things
 * that silently diverge if a port gets lazy:
 *
 *   - Ordering: prefix matches first (in vocabulary order), then substring-only
 *     matches (in vocabulary order). A prefix match must never repeat in the
 *     substring run. Get that wrong and the field still "works", it just ranks
 *     the wrong tag first, which no compiler will ever tell you about.
 *   - Casing: typing "vip" against a "VIP" vocabulary entry must ASSIGN "VIP".
 *     Storing the typed casing instead is how a vocabulary ends up with two
 *     entries that look identical to a human and different to a `==`.
 */
class TagAssignFieldTest {

    private fun def(name: String, icon: String = "") =
        TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = icon)

    private val vocab = listOf(def("VIP"), def("Reactive"), def("On meds"), def("Vet visit due"))

    // ---- canonical casing on assign ----

    @Test
    fun canonicalName_prefersTheVocabularyCasing() {
        assertEquals("VIP", canonicalTagName("vip", vocab))
        assertEquals("VIP", canonicalTagName("ViP", vocab))
        assertEquals("Reactive", canonicalTagName("REACTIVE", vocab))
    }

    @Test
    fun canonicalName_normalizesAFreeFormNameInstead() {
        // No vocabulary hit: keep the typed casing, but still normalize the shape.
        assertEquals("Chews shoes", canonicalTagName("  Chews   shoes  ", vocab))
        assertEquals("brand new", canonicalTagName("brand new", vocab))
    }

    @Test
    fun canonicalName_matchesAcrossWhitespaceShape() {
        // Normalization runs on BOTH sides of the comparison, so a sloppily typed
        // "on   meds" still finds the "On meds" entry.
        assertEquals("On meds", canonicalTagName("on   meds", vocab))
    }

    @Test
    fun canonicalName_onABlankInputIsBlank() {
        assertEquals("", canonicalTagName("   ", vocab))
    }

    // ---- vocabulary membership ----

    @Test
    fun inVocabulary_isCaseAndWhitespaceInsensitive() {
        assertTrue(tagInVocabulary("vip", vocab))
        assertTrue(tagInVocabulary("  On   meds ", vocab))
        assertFalse(tagInVocabulary("Chews shoes", vocab))
        assertFalse(tagInVocabulary("", vocab))
    }

    // ---- the "add to your tags" affordance ----

    @Test
    fun canCreate_onlyForANewNameWhenPromotionIsOffered() {
        assertTrue(canCreateTagVocab("Chews shoes", vocab, canPromote = true))
    }

    @Test
    fun canCreate_isFalseWhenTheCallerDoesNotOfferPromotion() {
        // No onCreateVocab in React means free-form assignment without growing
        // the vocabulary, so the affordance must not appear at all.
        assertFalse(canCreateTagVocab("Chews shoes", vocab, canPromote = false))
    }

    @Test
    fun canCreate_isFalseForABlankDraft() {
        assertFalse(canCreateTagVocab("", vocab, canPromote = true))
        assertFalse(canCreateTagVocab("   ", vocab, canPromote = true))
    }

    @Test
    fun canCreate_isFalseForANameAlreadyInTheVocabularyWhateverItsCasing() {
        // Offering "add VIP to your tags" when VIP already exists would walk the
        // operator straight into addTag's duplicate error.
        assertFalse(canCreateTagVocab("VIP", vocab, canPromote = true))
        assertFalse(canCreateTagVocab("vip", vocab, canPromote = true))
    }

    @Test
    fun createAffordanceLabel_quotesTheNormalizedName() {
        assertEquals("Add \"Chews shoes\" to your tags", tagCreateAffordanceLabel("Chews shoes"))
    }

    // ---- suggestion list visibility ----

    @Test
    fun suggestionList_showsOnlyWhenFocusedAndThereIsSomethingToShow() {
        assertTrue(showTagSuggestions(focused = true, suggestionCount = 3, canCreate = false))
        assertTrue(showTagSuggestions(focused = true, suggestionCount = 0, canCreate = true))
        assertFalse(showTagSuggestions(focused = true, suggestionCount = 0, canCreate = false))
        assertFalse(showTagSuggestions(focused = false, suggestionCount = 3, canCreate = true))
    }

    // ---- suggestion ordering (the shared engine, exercised through the field) ----

    @Test
    fun suggestions_rankPrefixMatchesBeforeSubstringMatches() {
        // "v" prefixes VIP and "Vet visit due"; it only appears mid-name in
        // "Reactive". Prefix hits come first, each run in vocabulary order.
        assertEquals(
            listOf("VIP", "Vet visit due", "Reactive"),
            suggestTags("v", vocab, already = emptyList()).map { it.name },
        )
    }

    @Test
    fun suggestions_neverRepeatAPrefixMatchInTheSubstringRun() {
        val names = suggestTags("v", vocab, already = emptyList()).map { it.name }
        assertEquals(names.size, names.toSet().size)
    }

    @Test
    fun suggestions_excludeWhatIsAlreadyAssignedCaseInsensitively() {
        assertEquals(
            listOf("Vet visit due", "Reactive"),
            suggestTags("v", vocab, already = listOf("vip")).map { it.name },
        )
    }

    @Test
    fun suggestions_onABlankQueryOfferTheWholeUnassignedPoolInVocabularyOrder() {
        // Focusing the empty field shows everything left to pick from.
        assertEquals(
            listOf("VIP", "Reactive", "On meds", "Vet visit due"),
            suggestTags("", vocab, already = emptyList()).map { it.name },
        )
        assertEquals(
            listOf("Reactive", "On meds", "Vet visit due"),
            suggestTags("   ", vocab, already = listOf("VIP")).map { it.name },
        )
    }

    // ---- what the field actually commits ----

    @Test
    fun assigning_aTypedNameStoresTheVocabularyCasing() {
        // The end-to-end rule this field exists to enforce: type "vip", store "VIP".
        val next = addAssigned(emptyList(), canonicalTagName("vip", vocab))
        assertEquals(listOf("VIP"), next)
    }

    @Test
    fun assigning_aFreeFormNameStoresItAsTyped() {
        val next = addAssigned(emptyList(), canonicalTagName("Chews Shoes", vocab))
        assertEquals(listOf("Chews Shoes"), next)
    }

    @Test
    fun assigning_anAlreadyAssignedNameIsANoOpWhateverItsCasing() {
        val already = listOf("VIP")
        assertEquals(already, addAssigned(already, canonicalTagName("vip", vocab)))
    }

    @Test
    fun assigning_appendsAtTheEndPreservingOrder() {
        val already = listOf("VIP", "On meds")
        assertEquals(
            listOf("VIP", "On meds", "Reactive"),
            addAssigned(already, canonicalTagName("reactive", vocab)),
        )
    }

    @Test
    fun removing_dropsTheChipCaseInsensitivelyAndKeepsTheRest() {
        val already = listOf("VIP", "On meds", "Reactive")
        assertEquals(listOf("VIP", "Reactive"), removeAssigned(already, "on meds"))
    }

    @Test
    fun removing_theLastChipYieldsAnEmptyListNotANoOp() {
        // Clearing the last tag has to genuinely empty the field, or the write
        // never clears `tags` on the doc.
        assertEquals(emptyList<String>(), removeAssigned(listOf("VIP"), "VIP"))
    }
}
