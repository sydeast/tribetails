package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable

/**
 * The tag vocabulary model + pure helpers, shared by the Business-settings Tags
 * editor (which manages the vocabulary) and the profile assign fields (which
 * reference tags by NAME). No Compose, no Firebase: everything here is a pure
 * transform, so it unit-tests on its own and serves wasm and desktop alike.
 *
 * This is a direct port of the React admin `src/lib/tags/model.ts` (plus
 * `suggestTags` from `src/lib/tags/assign.ts`), which is the authoring surface.
 * Both surfaces read and write the SAME Firestore docs, so the two MUST stay in
 * lock-step; [TagModelsTest] pins the behavior.
 *
 * A [TagDef] is a rich vocabulary entry: a `name` (the assignment key), a
 * palette `color`, and an `icon` (a plain emoji string in v1). Assignments on a
 * kinfolk / kin doc store only the NAME (`List<String>`); a name is resolved
 * back to its color / icon against the relevant vocabulary at render time. A
 * name with no matching vocab entry (a free-form tag, or one whose vocab entry
 * was removed) resolves to a neutral default chip rather than an error, so a tag
 * never "breaks" when its definition changes.
 *
 * TWO PORTING TRAPS, both load-bearing:
 *
 *  1. `color` is a `{ token, css }` PAIR, not a raw color. `token` is the stable
 *     palette identifier; `css` is a literal CSS var reference React paints the
 *     chip with. Kotlin has no CSS variables and paints from its own brand
 *     palette by TOKEN, but it must still persist `css` byte-for-byte unchanged,
 *     including a token this build has never heard of. Dropping `css`, or
 *     swapping in a hex, breaks the React admin on the next Kotlin save.
 *
 *  2. Every name COMPARISON here is case-insensitive on the normalized name,
 *     while name STORAGE keeps the casing exactly as typed ("VIP" stores as
 *     "VIP"). Getting only one of those halves right lets "vip" sit beside "VIP"
 *     as two separate tags.
 *
 * `icon` stays a plain String so a future `iconType` discriminator (emoji |
 * library | image) can be added without migrating existing docs.
 */

/** A palette entry: a stable [token] persisted on the doc, and its [css] paint value. */
@Serializable
data class TagColor(
    val token: String = "",
    // A literal CSS var reference, e.g. "var(--color-accent)". Kotlin never
    // parses or paints this; it round-trips it so React keeps working.
    val css: String = "",
)

// The seven palette entries, drawn straight from the Den role tokens (never a
// new color system): the same brand roles the rest of the app already paints
// with, so a tag chip reads as part of the Den. The `css` values below are the
// React token references, persisted verbatim.
//
// Declared BEFORE TagDef because TagDef's `color` default reads DEFAULT_TAG_COLOR,
// and top-level properties initialize in declaration order.
private val TEAL   = TagColor(token = "teal",   css = "var(--color-accent)")
private val ORANGE = TagColor(token = "orange", css = "var(--color-primary)")
private val PINK   = TagColor(token = "pink",   css = "var(--color-secondary)")
private val PURPLE = TagColor(token = "purple", css = "var(--color-tertiary)")
private val CORAL  = TagColor(token = "coral",  css = "var(--color-coral)")
private val GOLD   = TagColor(token = "gold",   css = "var(--color-warning)")
private val GREEN  = TagColor(token = "green",  css = "var(--color-success)")

/** The fixed palette. Order matters: the first entry is the default for a new tag. */
val TAG_PALETTE: List<TagColor> = listOf(TEAL, ORANGE, PINK, PURPLE, CORAL, GOLD, GREEN)

/** The color a new tag takes (a free-form tag added on a profile, or a fresh vocab row). */
val DEFAULT_TAG_COLOR: TagColor = TEAL

/** A vocabulary entry. [name] is the key assignments reference; [icon] is an emoji ("" = none). */
@Serializable
data class TagDef(
    val name: String = "",
    // Defaults to the palette default so a doc with no `color` at all decodes to
    // a paintable chip instead of a blank one.
    val color: TagColor = DEFAULT_TAG_COLOR,
    val icon: String = "",
)

/**
 * The longest a tag name may be. A name is the assignment key, so it stays short.
 *
 * 40 matches the React authoring surface (`MAX_TAG_NAME_LENGTH`, model.ts). The
 * backend independently accepts 60 (audienceCriteria.ts, saveTemplate.ts), so
 * the looser cap can never be tripped by a name authored here.
 */
const val MAX_TAG_NAME_LENGTH: Int = 40

/** Matches any run of whitespace, so a name collapses to single spaces. */
private val WHITESPACE_RUN = Regex("\\s+")

/** Trim and collapse internal whitespace runs to a single space. The one place name shape is decided. */
fun normalizeTagName(raw: String): String = raw.trim().replace(WHITESPACE_RUN, " ")

/**
 * Case-insensitive equality on normalized names, the rule every helper here
 * shares. Note this is NOT how tokens are compared (see [paletteColor]).
 */
private fun sameName(a: String, b: String): Boolean =
    normalizeTagName(a).equals(normalizeTagName(b), ignoreCase = true)

/** The comparison key for a tag name: normalized, then lowercased. */
private fun nameKey(name: String): String = normalizeTagName(name).lowercase()

/**
 * Look up a palette entry by its token. Unlike names, the token match is EXACT
 * and CASE-SENSITIVE (React: `TAG_PALETTE.find((c) => c.token === token)`), so
 * "TEAL" is an unknown token, not teal. An unknown token falls back to the
 * default rather than throwing, so a color written by a newer build still paints.
 */
fun paletteColor(token: String): TagColor =
    TAG_PALETTE.firstOrNull { it.token == token } ?: DEFAULT_TAG_COLOR

/** The result of resolving an assigned tag NAME against a vocabulary. */
data class ResolvedTag(
    /** The vocab entry's canonical name on a hit; the passed name on a miss. */
    val name: String,
    /** null on a miss (unknown / free-form / removed tag), which renders a neutral chip. */
    val color: TagColor? = null,
    /** null on a miss; on a hit the entry's emoji ("" when it has none). */
    val icon: String? = null,
)

/**
 * Resolve a tag NAME to its color / icon against a vocabulary (case-insensitive).
 * An unknown name resolves to `ResolvedTag(name, null, null)` so the chip renders
 * neutral, never an error. Never throws.
 *
 * On a hit the VOCAB entry's casing comes back, not the passed casing, so a tag
 * assigned as "vip" still renders as "VIP".
 */
fun resolveTag(name: String, vocab: List<TagDef>): ResolvedTag {
    val hit = vocab.firstOrNull { sameName(it.name, name) } ?: return ResolvedTag(name)
    return ResolvedTag(name = hit.name, color = hit.color, icon = hit.icon)
}

/**
 * Append a new vocab entry. Rejects a blank name and a name over the length cap,
 * and rejects a duplicate name case-insensitively (the name is the key, so two
 * "VIP"s would collide). Returns a new list; never mutates the input.
 *
 * Fails LOUD with the same user-facing copy the React admin shows, so the caller
 * can surface the message as-is instead of inventing its own. Checks run in the
 * order blank, length, duplicate.
 */
fun addTag(vocab: List<TagDef>, def: TagDef): List<TagDef> {
    val name = normalizeTagName(def.name)
    require(name != "") { "A tag name is required." }
    require(name.length <= MAX_TAG_NAME_LENGTH) {
        "A tag name must be $MAX_TAG_NAME_LENGTH characters or fewer."
    }
    require(vocab.none { sameName(it.name, name) }) { "A \"$name\" tag already exists." }
    // Stores the NORMALIZED name with its casing intact: only comparison lowercases.
    return vocab + TagDef(name = name, color = def.color, icon = def.icon)
}

/** Drop the vocab entry with this name (case-insensitive). Returns a new list. */
fun removeTag(vocab: List<TagDef>, name: String): List<TagDef> =
    vocab.filterNot { sameName(it.name, name) }

/**
 * Change an existing tag's color and/or icon. The name is the key and is never
 * changed here (renaming would orphan assignments; v1 is remove + add instead),
 * so the patch only carries color / icon. A null patch field leaves the existing
 * value, which is what makes `icon = ""` a real edit (clear the emoji) rather
 * than a no-op. Returns a new list.
 */
fun editTag(
    vocab: List<TagDef>,
    name: String,
    color: TagColor? = null,
    icon: String? = null,
): List<TagDef> = vocab.map { entry ->
    if (sameName(entry.name, name)) {
        entry.copy(color = color ?: entry.color, icon = icon ?: entry.icon)
    } else {
        entry
    }
}

/**
 * Suggest vocabulary tags for an autocomplete query, excluding tags already
 * assigned. Prefix matches rank before substring matches (each run in vocabulary
 * order), and a prefix match never repeats in the substring run. A blank query
 * returns every not-yet-assigned tag, so focusing the field shows the whole
 * vocabulary to pick from. Never mutates its inputs.
 */
fun suggestTags(input: String, vocab: List<TagDef>, already: List<String>): List<TagDef> {
    val assigned = already.map { nameKey(it) }.toSet()
    val pool = vocab.filterNot { nameKey(it.name) in assigned }
    val query = nameKey(input)
    if (query == "") return pool
    val starts = pool.filter { nameKey(it.name).startsWith(query) }
    val contains = pool.filter { !nameKey(it.name).startsWith(query) && nameKey(it.name).contains(query) }
    return starts + contains
}
