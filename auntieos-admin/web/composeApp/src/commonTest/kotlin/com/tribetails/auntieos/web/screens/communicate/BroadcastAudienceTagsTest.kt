package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Work item 22: the vocabulary-backed "By tag" broadcast audience picker.
 *
 * Every rule pinned here is a contract with something outside this file: the
 * React tag layer (case-insensitive comparison, canonical-casing storage), or
 * the broadcast backend (exact case-SENSITIVE tag matching, a 50-tag cap). The
 * two are not the same rule, which is exactly why the picker exists.
 */
class BroadcastAudienceTagsTest {

    private val vip = TagDef(name = "VIP", color = TagColor("gold", "var(--color-warning)"), icon = "⭐")
    private val monthly = TagDef(name = "Monthly plan", color = TagColor("teal", "var(--color-accent)"), icon = "")
    private val vacation = TagDef(name = "Vacation only", color = TagColor("pink", "var(--color-secondary)"), icon = "🏠")
    private val vocab = listOf(vip, monthly, vacation)

    // ── parseBroadcastTagText (migrating the old free-text field) ─────────────

    @Test fun parseSplitsTrimsAndDropsBlanks() {
        assertEquals(listOf("VIP", "Monthly plan"), parseBroadcastTagText(" VIP , , Monthly plan "))
    }

    @Test fun parseCollapsesInternalWhitespaceRuns() {
        assertEquals(listOf("Monthly plan"), parseBroadcastTagText("Monthly    plan"))
    }

    @Test fun parseDedupesCaseInsensitivelyKeepingTheFirstCasing() {
        assertEquals(listOf("VIP"), parseBroadcastTagText("VIP, vip, ViP"))
    }

    @Test fun parseOfBlankTextIsEmpty() {
        assertEquals(emptyList(), parseBroadcastTagText("   "))
    }

    // ── addBroadcastTag ──────────────────────────────────────────────────────

    @Test fun addPrefersTheVocabularyCasing() {
        // The backend compares tag strings EXACTLY (audienceCriteria.ts matchesCriteria
        // trims but never lowercases), and profiles store the vocab casing, so
        // "vip" typed here has to go out as "VIP" or it reaches nobody.
        assertEquals(listOf("VIP"), addBroadcastTag(emptyList(), "vip", vocab))
    }

    @Test fun addNormalizesAnUnknownNameAndKeepsItsCasing() {
        // Trimmed, internal whitespace runs collapsed, casing left exactly as typed.
        assertEquals(listOf("Beach House"), addBroadcastTag(emptyList(), "  Beach   House  ", vocab))
    }

    @Test fun addIsANoOpForABlankName() {
        assertEquals(listOf("VIP"), addBroadcastTag(listOf("VIP"), "   ", vocab))
    }

    @Test fun addDedupesCaseInsensitively() {
        assertEquals(listOf("VIP"), addBroadcastTag(listOf("VIP"), "vip", vocab))
    }

    @Test fun addAppendsAtTheEnd() {
        assertEquals(listOf("VIP", "Monthly plan"), addBroadcastTag(listOf("VIP"), "monthly plan", vocab))
    }

    @Test fun addDoesNotMutateTheInput() {
        val original = listOf("VIP")
        addBroadcastTag(original, "Monthly plan", vocab)
        assertEquals(listOf("VIP"), original)
    }

    // ── removeBroadcastTag / toggleBroadcastTag ──────────────────────────────

    @Test fun removeIsCaseInsensitiveAndKeepsOrder() {
        assertEquals(
            listOf("VIP", "Vacation only"),
            removeBroadcastTag(listOf("VIP", "Monthly plan", "Vacation only"), "MONTHLY PLAN"),
        )
    }

    @Test fun removeOfAnAbsentNameChangesNothing() {
        assertEquals(listOf("VIP"), removeBroadcastTag(listOf("VIP"), "Ghost"))
    }

    @Test fun toggleAddsWhenAbsentAndRemovesWhenPresent() {
        val once = toggleBroadcastTag(emptyList(), "vip", vocab)
        assertEquals(listOf("VIP"), once)
        assertEquals(emptyList(), toggleBroadcastTag(once, "VIP", vocab))
    }

    @Test fun toggleRemovesEvenWhenTheCasingDiffers() {
        assertEquals(emptyList(), toggleBroadcastTag(listOf("VIP"), "vip", vocab))
    }

    // ── broadcastTagSuggestions ──────────────────────────────────────────────

    @Test fun suggestionsRankPrefixMatchesBeforeSubstringMatches() {
        val hits = broadcastTagSuggestions("v", vocab, emptyList()).map { it.name }
        // "VIP" and "Vacation only" start with v (vocab order); "Monthly plan" does not contain v.
        assertEquals(listOf("VIP", "Vacation only"), hits)
    }

    @Test fun suggestionsIncludeSubstringOnlyMatchesAfterPrefixes() {
        val hits = broadcastTagSuggestions("a", vocab, emptyList()).map { it.name }
        // No name starts with "a"; "Monthly plan" and "Vacation only" both contain it, in vocab order.
        assertEquals(listOf("Monthly plan", "Vacation only"), hits)
    }

    @Test fun suggestionsExcludeAlreadySelectedCaseInsensitively() {
        val hits = broadcastTagSuggestions("", vocab, listOf("vip")).map { it.name }
        assertEquals(listOf("Monthly plan", "Vacation only"), hits)
    }

    @Test fun blankQueryOffersTheWholeUnselectedVocabulary() {
        assertEquals(3, broadcastTagSuggestions("   ", vocab, emptyList()).size)
    }

    // ── unknownBroadcastTags + the warning copy ──────────────────────────────

    @Test fun unknownTagsAreTheOnesWithNoVocabularyEntry() {
        assertEquals(listOf("Ghost"), unknownBroadcastTags(listOf("vip", "Ghost"), vocab))
    }

    @Test fun aTagThatOnlyDiffersByCaseIsNotUnknown() {
        assertEquals(emptyList(), unknownBroadcastTags(listOf("vIp"), vocab))
    }

    @Test fun noWarningWhenEveryTagIsInTheVocabulary() {
        assertNull(broadcastTagVocabWarning(listOf("VIP"), vocab, vocabLoaded = true))
    }

    @Test fun warningNamesTheUnknownTags() {
        val w = broadcastTagVocabWarning(listOf("VIP", "Ghost", "Spectre"), vocab, vocabLoaded = true)
        assertNotNull(w)
        assertTrue(w.contains("Ghost"), "warning should name the unknown tag: $w")
        assertTrue(w.contains("Spectre"), "warning should name every unknown tag: $w")
    }

    @Test fun noWarningBeforeTheVocabularyHasLoaded() {
        // Everything would look unknown against an empty list, which would be a lie.
        assertNull(broadcastTagVocabWarning(listOf("VIP"), emptyList(), vocabLoaded = false))
    }

    // ── broadcastTagCapProblem (the server's own limit) ──────────────────────

    @Test fun capAllowsExactlyFifty() {
        assertNull(broadcastTagCapProblem((1..MAX_BROADCAST_TAGS).map { "tag $it" }))
    }

    @Test fun capBlocksFiftyOneAndSaysTheLimit() {
        val problem = broadcastTagCapProblem((1..MAX_BROADCAST_TAGS + 1).map { "tag $it" })
        assertNotNull(problem)
        assertTrue(problem.contains("$MAX_BROADCAST_TAGS"), "cap message should state the limit: $problem")
    }

    @Test fun capMatchesTheServerSchema() {
        // audienceCriteria.ts CriteriaSchema: tags: z.array(...).max(50)
        assertEquals(50, MAX_BROADCAST_TAGS)
    }
}
