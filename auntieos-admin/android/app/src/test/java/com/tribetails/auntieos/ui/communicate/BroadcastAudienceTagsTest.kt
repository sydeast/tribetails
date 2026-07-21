package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Work item 22: the vocabulary-backed "By tag" broadcast audience picker.
 *
 * The android twin of the commonMain BroadcastAudienceTagsTest. The two trees
 * share no code, so this file is written independently and pins the same rules:
 * the tag layer compares names case-insensitively, the broadcast backend
 * compares them EXACTLY, and the picker is what stops those two from disagreeing
 * quietly.
 */
class BroadcastAudienceTagsTest {

    private val vip = TagDef(name = "VIP", color = TagColor("gold", "var(--color-warning)"), icon = "⭐")
    private val monthly = TagDef(name = "Monthly plan", color = TagColor("teal", "var(--color-accent)"), icon = "")
    private val vacation = TagDef(name = "Vacation only", color = TagColor("pink", "var(--color-secondary)"), icon = "🏠")
    private val vocab = listOf(vip, monthly, vacation)

    // ── parseBroadcastTagText (migrating the old free-text field) ─────────────

    @Test fun `parse splits trims and drops blanks`() {
        assertEquals(listOf("VIP", "Monthly plan"), parseBroadcastTagText(" VIP , , Monthly plan "))
    }

    @Test fun `parse collapses internal whitespace runs`() {
        assertEquals(listOf("Monthly plan"), parseBroadcastTagText("Monthly    plan"))
    }

    @Test fun `parse dedupes case insensitively keeping the first casing`() {
        assertEquals(listOf("VIP"), parseBroadcastTagText("VIP, vip, ViP"))
    }

    @Test fun `parse of blank text is empty`() {
        assertEquals(emptyList<String>(), parseBroadcastTagText("   "))
    }

    // ── addBroadcastTag ──────────────────────────────────────────────────────

    @Test fun `add prefers the vocabulary casing`() {
        // audienceCriteria.ts matchesCriteria trims but never lowercases, and a
        // profile stores the vocab casing, so "vip" has to go out as "VIP".
        assertEquals(listOf("VIP"), addBroadcastTag(emptyList(), "vip", vocab))
    }

    @Test fun `add normalizes an unknown name and keeps its casing`() {
        assertEquals(listOf("Beach House"), addBroadcastTag(emptyList(), "  Beach   House  ", vocab))
    }

    @Test fun `add is a no-op for a blank name`() {
        assertEquals(listOf("VIP"), addBroadcastTag(listOf("VIP"), "   ", vocab))
    }

    @Test fun `add dedupes case insensitively`() {
        assertEquals(listOf("VIP"), addBroadcastTag(listOf("VIP"), "vip", vocab))
    }

    @Test fun `add appends at the end`() {
        assertEquals(listOf("VIP", "Monthly plan"), addBroadcastTag(listOf("VIP"), "monthly plan", vocab))
    }

    @Test fun `add does not mutate the input`() {
        val original = listOf("VIP")
        addBroadcastTag(original, "Monthly plan", vocab)
        assertEquals(listOf("VIP"), original)
    }

    // ── removeBroadcastTag / toggleBroadcastTag ──────────────────────────────

    @Test fun `remove is case insensitive and keeps order`() {
        assertEquals(
            listOf("VIP", "Vacation only"),
            removeBroadcastTag(listOf("VIP", "Monthly plan", "Vacation only"), "MONTHLY PLAN"),
        )
    }

    @Test fun `remove of an absent name changes nothing`() {
        assertEquals(listOf("VIP"), removeBroadcastTag(listOf("VIP"), "Ghost"))
    }

    @Test fun `toggle adds when absent and removes when present`() {
        val once = toggleBroadcastTag(emptyList(), "vip", vocab)
        assertEquals(listOf("VIP"), once)
        assertEquals(emptyList<String>(), toggleBroadcastTag(once, "VIP", vocab))
    }

    @Test fun `toggle removes even when the casing differs`() {
        assertEquals(emptyList<String>(), toggleBroadcastTag(listOf("VIP"), "vip", vocab))
    }

    // ── broadcastTagSuggestions ──────────────────────────────────────────────

    @Test fun `suggestions rank prefix matches before substring matches`() {
        val hits = broadcastTagSuggestions("v", vocab, emptyList()).map { it.name }
        assertEquals(listOf("VIP", "Vacation only"), hits)
    }

    @Test fun `suggestions include substring only matches after prefixes`() {
        val hits = broadcastTagSuggestions("a", vocab, emptyList()).map { it.name }
        assertEquals(listOf("Monthly plan", "Vacation only"), hits)
    }

    @Test fun `suggestions exclude already selected case insensitively`() {
        val hits = broadcastTagSuggestions("", vocab, listOf("vip")).map { it.name }
        assertEquals(listOf("Monthly plan", "Vacation only"), hits)
    }

    @Test fun `blank query offers the whole unselected vocabulary`() {
        assertEquals(3, broadcastTagSuggestions("   ", vocab, emptyList()).size)
    }

    // ── unknownBroadcastTags + the warning copy ──────────────────────────────

    @Test fun `unknown tags are the ones with no vocabulary entry`() {
        assertEquals(listOf("Ghost"), unknownBroadcastTags(listOf("vip", "Ghost"), vocab))
    }

    @Test fun `a tag that only differs by case is not unknown`() {
        assertEquals(emptyList<String>(), unknownBroadcastTags(listOf("vIp"), vocab))
    }

    @Test fun `no warning when every tag is in the vocabulary`() {
        assertNull(broadcastTagVocabWarning(listOf("VIP"), vocab, vocabLoaded = true))
    }

    @Test fun `warning names the unknown tags`() {
        val w = broadcastTagVocabWarning(listOf("VIP", "Ghost", "Spectre"), vocab, vocabLoaded = true)
        assertNotNull(w)
        assertTrue("warning should name the unknown tag: $w", w!!.contains("Ghost"))
        assertTrue("warning should name every unknown tag: $w", w.contains("Spectre"))
    }

    @Test fun `no warning before the vocabulary has loaded`() {
        // Everything would look unknown against an empty list, which would be a lie.
        assertNull(broadcastTagVocabWarning(listOf("VIP"), emptyList(), vocabLoaded = false))
    }

    // ── broadcastTagCapProblem (the server's own limit) ──────────────────────

    @Test fun `cap allows exactly fifty`() {
        assertNull(broadcastTagCapProblem((1..MAX_BROADCAST_TAGS).map { "tag $it" }))
    }

    @Test fun `cap blocks fifty one and says the limit`() {
        val problem = broadcastTagCapProblem((1..MAX_BROADCAST_TAGS + 1).map { "tag $it" })
        assertNotNull(problem)
        assertTrue("cap message should state the limit: $problem", problem!!.contains("$MAX_BROADCAST_TAGS"))
    }

    @Test fun `cap matches the server schema`() {
        // audienceCriteria.ts CriteriaSchema: tags: z.array(...).max(50)
        assertEquals(50, MAX_BROADCAST_TAGS)
    }
}
