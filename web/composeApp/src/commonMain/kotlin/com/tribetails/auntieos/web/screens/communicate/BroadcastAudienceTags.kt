package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.normalizeTagName
import com.tribetails.auntieos.web.data.suggestTags

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast "By tag" audience picker (work item 22): pure selection logic.
//
// The old field was free text ("vip, monthly"). That was a quiet way to send a
// broadcast to nobody, because THREE different case rules meet here and only one
// of them forgives a typo:
//
//   1. The tag VOCABULARY layer (web/data/TagModels.kt, ported from the React
//      admin src/lib/tags) compares names case-INsensitively but STORES the
//      casing as authored, so a household carries "VIP", never "vip".
//   2. The broadcast BACKEND compares tag strings EXACTLY. MyTribe
//      functions/src/admin/audienceCriteria.ts matchesCriteria builds
//      `new Set((k.tags ?? []).map((t) => t.trim()))` and asks `have.has(t)`:
//      trimmed on both sides, never lowercased. "vip" does not match "VIP".
//   3. Status matching in that same function DOES lowercase, so the operator has
//      no reason to expect tags to behave the same way.
//
// So the picker resolves every chosen name to the vocabulary's canonical casing
// ([addBroadcastTag]) and warns, visibly, about any selected name the vocabulary
// has never heard of ([broadcastTagVocabWarning]). It never silently rewrites or
// silently drops a tag: an off-vocabulary name is still sent (free-form tags on
// a household are legal), it just says so out loud first.
//
// SCOPE: household tags only. The server criteria schema has no pet-tag kind,
// and the resolver reads `kinfolk.tags`. Offering pet tags here would build an
// audience the server ignores, so this picker only ever shows `householdTags`.
//
// Everything in this file is pure so it unit-tests without a Compose runtime,
// which is the pattern the rest of the Communicate screen already follows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most tags one audience may carry. Matches the server schema exactly:
 * `tags: z.array(z.string().min(1).max(60)).max(50).optional()` in
 * audienceCriteria.ts. Going over is a hard server rejection, so the form blocks
 * first with copy the operator can act on rather than letting Zod answer.
 *
 * The per-name length cap is the vocabulary's 40 (MAX_TAG_NAME_LENGTH), which is
 * tighter than the server's 60, so a name authored in the Tags editor can never
 * trip the server's own limit.
 */
const val MAX_BROADCAST_TAGS: Int = 50

/** The comparison key for a tag name: normalized, then lowercased. Comparison only. */
private fun nameKey(name: String): String = normalizeTagName(name).lowercase()

// Chip PAINTING is not defined here. The picker renders through the shared
// ui/components/TagChip, which owns the token-to-brand-swatch mapping (and the
// rule that the stored `css` string is round-tripped, never parsed), so a tag
// chip on a broadcast audience reads the same as one on a profile.

/**
 * Read an existing comma-separated tag string into a selection. This is how a
 * saved segment authored before the picker, or a criteria decoded off the wire,
 * becomes chips. Names are normalized and deduped case-insensitively (the first
 * casing seen wins, matching what the backend would have matched anyway).
 */
fun parseBroadcastTagText(text: String): List<String> {
    val out = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    text.split(',').forEach { raw ->
        val name = normalizeTagName(raw)
        if (name.isEmpty()) return@forEach
        if (seen.add(nameKey(name))) out += name
    }
    return out
}

/**
 * Add a tag to the selection, preferring the VOCABULARY's casing when the typed
 * name matches an entry case-insensitively, because that is the casing the
 * household doc actually carries and the server compares exactly. A blank name
 * is a no-op, a case-insensitive duplicate is a no-op, and the tag appends at
 * the end. Returns a new list; never mutates the input.
 *
 * A name with no vocabulary entry is kept as typed (normalized). It is not an
 * error: free-form tags exist on households. [broadcastTagVocabWarning] is what
 * makes that visible.
 */
fun addBroadcastTag(selected: List<String>, name: String, vocab: List<TagDef>): List<String> {
    val normalized = normalizeTagName(name)
    if (normalized.isEmpty()) return selected
    val canonical = vocab.firstOrNull { nameKey(it.name) == nameKey(normalized) }?.name ?: normalized
    if (selected.any { nameKey(it) == nameKey(canonical) }) return selected
    return selected + canonical
}

/** Drop a tag from the selection (case-insensitive), preserving order. New list. */
fun removeBroadcastTag(selected: List<String>, name: String): List<String> {
    val key = nameKey(name)
    return selected.filterNot { nameKey(it) == key }
}

/** Add the tag if it is not selected, drop it if it is. Case-insensitive both ways. */
fun toggleBroadcastTag(selected: List<String>, name: String, vocab: List<TagDef>): List<String> =
    if (selected.any { nameKey(it) == nameKey(name) }) {
        removeBroadcastTag(selected, name)
    } else {
        addBroadcastTag(selected, name, vocab)
    }

/**
 * The vocabulary entries to offer for a query, minus the ones already selected.
 * Delegates to the shared [suggestTags] so the picker ranks identically to every
 * other tag field: prefix matches first (in vocabulary order), then
 * substring-only matches, and a blank query offers the whole unselected pool.
 */
fun broadcastTagSuggestions(query: String, vocab: List<TagDef>, selected: List<String>): List<TagDef> =
    suggestTags(query, vocab, selected)

/** Selected names with no vocabulary entry (case-insensitive), in selection order. */
fun unknownBroadcastTags(selected: List<String>, vocab: List<TagDef>): List<String> {
    val known = vocab.map { nameKey(it.name) }.toSet()
    return selected.filterNot { nameKey(it) in known }
}

/**
 * Warning copy for tags the household vocabulary does not know, or null when
 * every selected tag is a real vocabulary entry.
 *
 * Off-vocabulary is a warning, not a blocker: a household can carry a free-form
 * tag written before the vocabulary existed, and blocking would be wrong. What
 * would be wrong to hide is that the server compares tag text exactly, so a
 * typo here reaches nobody and reports a clean zero.
 *
 * [vocabLoaded] guards against the honest-looking lie of calling everything
 * unknown while the vocabulary is still loading or failed to load.
 */
fun broadcastTagVocabWarning(selected: List<String>, vocab: List<TagDef>, vocabLoaded: Boolean): String? {
    if (!vocabLoaded) return null
    val unknown = unknownBroadcastTags(selected, vocab)
    if (unknown.isEmpty()) return null
    val names = unknown.joinToString(", ")
    return "$names: not in your household tag list. " +
        "Tag matching is exact, so a name spelled differently reaches nobody."
}

/**
 * Blocking problem when the selection is over the server's cap, or null. Kept
 * separate from [broadcastTagVocabWarning] because this one genuinely stops a
 * send: the server rejects the whole call, so nothing goes out either way.
 */
fun broadcastTagCapProblem(selected: List<String>): String? =
    if (selected.size <= MAX_BROADCAST_TAGS) {
        null
    } else {
        "One audience can carry $MAX_BROADCAST_TAGS tags at most. " +
            "This one has ${selected.size}. Drop ${selected.size - MAX_BROADCAST_TAGS} to send."
    }
