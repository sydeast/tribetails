package com.tribetails.auntieos.data.model

// Pure helpers for the tag vocabulary, ported from the React admin
// (auntieos-admin src/lib/tags/model.ts and src/lib/tags/assign.ts). React is
// the reference implementation and the two Kotlin trees (this one and
// web/composeApp commonMain) share no code, so this file is written
// independently and TagModelsTest.kt pins the wire contract literally. Any
// change here needs the same change in the commonMain twin.
//
// The wire models themselves ([TagColor], [TagDef]) and the Firestore decode
// gate ([decodeTagDefs], [encodeTagDefs], [decodeTagNames]) live in Models.kt
// beside the profile models they hang off. This file holds only the pure
// transforms: the palette, the name-shape rule, and the vocabulary/assignment
// helpers. No Firebase and no Compose, so every function here is unit-testable
// on its own.
//
// A [TagDef] is a rich vocabulary entry: a `name` (the assignment key), a
// palette `color`, and an `icon` (a plain emoji string in v1, "" for none).
// Assignments on a kinfolk/kin doc store only the NAME; a name is resolved back
// to its color/icon against the relevant vocabulary at render time, and a name
// with no matching vocab entry (a free-form tag, or one whose vocab entry was
// removed) resolves to a neutral chip rather than an error, so a tag never
// "breaks" when its definition changes.
//
// [TagColor] is a `{ token, css }` pair, not a raw hex. `token` is the stable
// palette identifier persisted on the doc; `css` is the token's `var(--color-*)`
// reference React paints the chip with. Android has no CSS variables and paints
// by TOKEN from its own brand palette, but it MUST round-trip both fields
// unchanged or the React admin stops rendering its own chips.

// ----- Scope -----

/**
 * Which vocabulary a tag belongs to. Household tags live on `kinfolk` docs, pet
 * tags on `kin` docs. The wire values are lowercase (matching the React
 * `TagScope` union); [vocabField] is the business_settings field holding the
 * list.
 */
enum class TagScope(val wire: String, val vocabField: String) {
    HOUSEHOLD("household", "householdTags"),
    PET("pet", "petTags");

    companion object {
        /** Parse a stored scope string case-insensitively. Unknown/blank -> HOUSEHOLD. */
        fun fromWire(value: String?): TagScope =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) } ?: HOUSEHOLD
    }
}

// ----- Palette -----

// The seven palette entries, drawn straight from the Den role tokens (never a
// new color system). The css strings are the React literals verbatim: android
// paints by token from its own brand palette and writes these back untouched.
private val TEAL = TagColor(token = "teal", css = "var(--color-accent)")
private val ORANGE = TagColor(token = "orange", css = "var(--color-primary)")
private val PINK = TagColor(token = "pink", css = "var(--color-secondary)")
private val PURPLE = TagColor(token = "purple", css = "var(--color-tertiary)")
private val CORAL = TagColor(token = "coral", css = "var(--color-coral)")
private val GOLD = TagColor(token = "gold", css = "var(--color-warning)")
private val GREEN = TagColor(token = "green", css = "var(--color-success)")

private val PALETTE = listOf(TEAL, ORANGE, PINK, PURPLE, CORAL, GOLD, GREEN)

/**
 * The fixed palette. Order matters: the first entry is the default for a new
 * tag. Every accessor hands out fresh copies, because [TagColor] carries `var`
 * fields for Firebase's setter-based decode: a caller that stored a shared
 * instance on a [TagDef] and then edited it would silently repaint the palette
 * itself.
 */
val TAG_PALETTE: List<TagColor>
    get() = PALETTE.map { it.copy() }

/** The default color a new tag takes (a free-form tag added on a profile, or a fresh vocab row). */
val DEFAULT_TAG_COLOR: TagColor
    get() = TEAL.copy()

/**
 * The palette tokens in order, for a swatch picker that only needs the stable
 * identifiers. Painting maps the token onto android's own brand palette; the
 * stored `css` string is never parsed, only round-tripped.
 */
val TAG_PALETTE_TOKENS: List<String> = PALETTE.map { it.token }

/**
 * The longest a tag name may be. 40 matches the React authoring surface
 * (MAX_TAG_NAME_LENGTH in src/lib/tags/model.ts), deliberately tighter than the
 * backend's independent cap of 60 (audienceCriteria.ts, saveTemplate.ts), so a
 * name authored here can never trip a backend validator.
 */
const val MAX_TAG_NAME_LENGTH: Int = 40

/**
 * Look up a palette entry by its token. The lookup is EXACT and
 * case-SENSITIVE, unlike name comparisons: the token is a stable identifier,
 * not user copy. An unknown token falls back to the default; never throws, and
 * never rewrites what is stored on the doc.
 */
fun paletteColor(token: String): TagColor =
    (PALETTE.firstOrNull { it.token == token } ?: TEAL).copy()

// ----- Name shape -----

private val WHITESPACE_RUN = Regex("\\s+")

/**
 * Trim and collapse internal whitespace runs to a single space. The one place
 * name shape is decided, mirroring the React `normalizeTagName`. Case is left
 * alone: only COMPARISON lowercases, storage keeps the casing as typed, so
 * "VIP" stays "VIP".
 */
fun normalizeTagName(raw: String): String = raw.trim().replace(WHITESPACE_RUN, " ")

/**
 * Case-insensitive equality on normalized names, the rule every helper here
 * shares. Getting this wrong is the single most-copied porting bug: a plain
 * `==` would let "vip" sit beside "VIP" as two separate tags.
 */
private fun sameName(a: String, b: String): Boolean =
    normalizeTagName(a).equals(normalizeTagName(b), ignoreCase = true)

/** The comparison key for a name: normalized, then lowercased. */
private fun key(name: String): String = normalizeTagName(name).lowercase()

// ----- Vocabulary helpers (pure) -----

/** The result of resolving an assigned NAME against a vocabulary. */
data class ResolvedTag(
    /** The vocab entry's canonical name on a hit; the passed name on a miss. */
    val name: String,
    /** null on a miss (unknown/free-form/removed tag) -> a neutral default chip. */
    val color: TagColor?,
    /** null on a miss; on a hit the entry's emoji ("" when it has none). */
    val icon: String?,
)

/**
 * Resolve a tag NAME to its color/icon against a vocabulary (case-insensitive).
 * On a hit the vocab entry's CANONICAL casing is returned, not the passed
 * casing. An unknown name resolves to `ResolvedTag(name, null, null)` so the
 * chip renders neutral, never an error. Never throws.
 */
fun resolveTag(name: String, vocab: List<TagDef>): ResolvedTag {
    val hit = vocab.firstOrNull { sameName(it.name, name) }
        ?: return ResolvedTag(name = name, color = null, icon = null)
    return ResolvedTag(name = hit.name, color = hit.color, icon = hit.icon)
}

/**
 * Append a new vocab entry. Rejects a blank name, a name over the length cap,
 * and a case-insensitive duplicate (the name is the key, so two "VIP"s would
 * collide). Checks run blank, then length, then duplicate. Returns a new list;
 * never mutates the input.
 *
 * Fails loud with the exact user-facing copy the React editor shows, so the two
 * admin surfaces read identically.
 */
fun addTag(vocab: List<TagDef>, def: TagDef): List<TagDef> {
    val name = normalizeTagName(def.name)
    require(name != "") { "A tag name is required." }
    require(name.length <= MAX_TAG_NAME_LENGTH) {
        "A tag name must be $MAX_TAG_NAME_LENGTH characters or fewer."
    }
    require(vocab.none { sameName(it.name, name) }) { "A \"$name\" tag already exists." }
    return vocab + TagDef(name = name, color = def.color, icon = def.icon)
}

/** Drop the vocab entry with this name (case-insensitive). Returns a new list. */
fun removeTag(vocab: List<TagDef>, name: String): List<TagDef> =
    vocab.filterNot { sameName(it.name, name) }

/**
 * Change an existing tag's color and/or icon. The name is the key and is never
 * changed here (renaming would orphan assignments; v1 is remove + add instead),
 * so the patch only carries [color]/[icon]. A null patch argument means "leave
 * it alone"; an empty [icon] string is a real value ("No emoji"). Returns a new
 * list, and entries that do not match keep their identity.
 */
fun editTag(
    vocab: List<TagDef>,
    name: String,
    color: TagColor? = null,
    icon: String? = null,
): List<TagDef> = vocab.map { t ->
    if (sameName(t.name, name)) {
        t.copy(color = color ?: t.color, icon = icon ?: t.icon)
    } else {
        t
    }
}

// ----- Assign-field helpers (pure) -----

/**
 * Suggest vocabulary tags for an autocomplete query, excluding tags already
 * assigned. Prefix matches rank before substring matches (each in vocab order),
 * and a prefix match never also appears in the contains list. A blank query
 * returns every not-yet-assigned tag, so focusing the field shows the whole
 * vocabulary to pick from. Never mutates its inputs.
 */
fun suggestTags(input: String, vocab: List<TagDef>, already: List<String>): List<TagDef> {
    val assigned = already.map { key(it) }.toSet()
    val pool = vocab.filterNot { assigned.contains(key(it.name)) }
    val q = key(input)
    if (q == "") return pool
    val starts = pool.filter { key(it.name).startsWith(q) }
    val contains = pool.filter { !key(it.name).startsWith(q) && key(it.name).contains(q) }
    return starts + contains
}

/**
 * Add a tag name to the assigned list: normalized, and deduped
 * case-insensitively (so "vip" is not added beside an existing "VIP"). A blank
 * name is a no-op. Appends at the end. Returns a new list.
 */
fun addAssigned(already: List<String>, name: String): List<String> {
    val n = normalizeTagName(name)
    if (n == "") return already
    if (already.any { key(it) == key(n) }) return already
    return already + n
}

/** Remove a tag name from the assigned list (case-insensitive), preserving order. */
fun removeAssigned(already: List<String>, name: String): List<String> {
    val k = key(name)
    return already.filterNot { key(it) == k }
}

/**
 * Prefer the vocabulary's canonical casing when a typed name matches an entry,
 * so assigning "vip" against a "VIP" vocab stores "VIP". On a miss the
 * normalized typed name is used as-is.
 */
fun canonicalTagName(name: String, vocab: List<TagDef>): String =
    vocab.firstOrNull { sameName(it.name, name) }?.name ?: normalizeTagName(name)
