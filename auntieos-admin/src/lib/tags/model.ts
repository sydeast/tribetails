/**
 * The tag vocabulary model + pure helpers, shared by the Business-settings Tags
 * editor (which manages the vocabulary) and the profile assign fields (which
 * reference tags by NAME). No React, no Firebase: everything here is a pure
 * transform so it can be unit-tested on its own and reused on every surface.
 *
 * A `TagDef` is a rich vocabulary entry: a `name` (the assignment key), a
 * palette `color`, and an `icon` (a plain emoji string in v1). Assignments on a
 * kinfolk/kin doc store only the NAME (`string[]`); a name is resolved back to
 * its color/icon against the relevant vocabulary at render time. A name with no
 * matching vocab entry resolves to a neutral default chip rather than an error,
 * so a tag never "breaks" when its definition changes.
 *
 * #713 changed WHICH names reach that neutral path. Deleting a tag used to drop
 * the vocabulary row and leave every assignment standing, so a deleted tag lived
 * on as a neutral chip on the households carrying it. The operator ruled against
 * that: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY." A delete now runs
 * through the `removeBusinessTag` callable, which strips the name off every
 * `kinfolk` (or `kin`) doc as well as off the list. The neutral chip therefore
 * covers a free-form name a profile assigned without promoting it to the
 * vocabulary, and legacy docs written before the cascade existed. It is no
 * longer the documented outcome of pressing Remove.
 *
 * `color` is a `{ token, css }` pair, not a raw hex: `token` is the stable
 * palette identifier persisted on the doc, `css` is the token's `var(--color-*)`
 * reference used to paint the chip. Keeping both means a stored tag always maps
 * to one of the fixed palette entries below, never a free color. `icon` stays a
 * plain string so a future `iconType` discriminator (emoji | library | image)
 * can be added without migrating existing `{ name, color, icon }` docs.
 */

/** Which vocabulary a tag belongs to. Household tags live on `kinfolk`, pet tags on `kin`. */
export type TagScope = 'household' | 'pet';

/** A palette entry: a stable `token` persisted on the doc, and its `css` paint value. */
export interface TagColor {
  token: string;
  css: string;
}

/** A vocabulary entry. `name` is the key assignments reference; `icon` is an emoji ('' = none). */
export interface TagDef {
  name: string;
  color: TagColor;
  icon: string;
}

// The seven palette entries, drawn straight from the Den role tokens in
// `styles/tokens.css` (never a new color system): the same brand roles the rest
// of the app already paints with, so a tag chip reads as part of the Den.
const TEAL: TagColor = { token: 'teal', css: 'var(--color-accent)' };
const ORANGE: TagColor = { token: 'orange', css: 'var(--color-primary)' };
const PINK: TagColor = { token: 'pink', css: 'var(--color-secondary)' };
const PURPLE: TagColor = { token: 'purple', css: 'var(--color-tertiary)' };
const CORAL: TagColor = { token: 'coral', css: 'var(--color-coral)' };
const GOLD: TagColor = { token: 'gold', css: 'var(--color-warning)' };
const GREEN: TagColor = { token: 'green', css: 'var(--color-success)' };

/** The fixed palette. Order matters: the first entry is the default for a new tag. */
export const TAG_PALETTE: readonly TagColor[] = [TEAL, ORANGE, PINK, PURPLE, CORAL, GOLD, GREEN];

/** The default color a new tag takes (a free-form tag added on a profile, or a fresh vocab row). */
export const DEFAULT_TAG_COLOR: TagColor = TEAL;

/** The longest a tag name may be. A name is the assignment key, so it stays short. */
export const MAX_TAG_NAME_LENGTH = 40;

/** Trim and collapse internal whitespace runs to a single space. The one place name shape is decided. */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Case-insensitive equality on normalized names, the rule every helper here shares. */
function sameName(a: string, b: string): boolean {
  return normalizeTagName(a).toLowerCase() === normalizeTagName(b).toLowerCase();
}

/** Look up a palette entry by its token; falls back to the default for an unknown token. */
export function paletteColor(token: string): TagColor {
  return TAG_PALETTE.find((c) => c.token === token) ?? DEFAULT_TAG_COLOR;
}

export interface ResolvedTag {
  /** The vocab entry's canonical name on a hit; the passed name on a miss. */
  name: string;
  /** null on a miss (unknown/free-form/removed tag) -> a neutral default chip. */
  color: TagColor | null;
  /** null on a miss; on a hit the entry's emoji ('' when it has none). */
  icon: string | null;
}

/**
 * Resolve a tag NAME to its color/icon against a vocabulary (case-insensitive).
 * An unknown name resolves to `{ name, color: null, icon: null }` so the chip
 * renders neutral, never an error. Never throws. See the header for what an
 * unknown name means now that a delete cascades: a free-form assignment or a
 * legacy doc, not a tag the operator just removed.
 */
export function resolveTag(name: string, vocab: TagDef[]): ResolvedTag {
  const hit = vocab.find((t) => sameName(t.name, name));
  if (hit === undefined) return { name, color: null, icon: null };
  return { name: hit.name, color: hit.color, icon: hit.icon };
}

/**
 * Append a new vocab entry. Rejects a blank name and a name over the length
 * cap, and rejects a duplicate name case-insensitively (the name is the key, so
 * two "VIP"s would collide). Returns a new array; never mutates the input.
 */
export function addTag(vocab: TagDef[], def: TagDef): TagDef[] {
  const name = normalizeTagName(def.name);
  if (name === '') throw new Error('A tag name is required.');
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw new Error(`A tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer.`);
  }
  if (vocab.some((t) => sameName(t.name, name))) {
    throw new Error(`A "${name}" tag already exists.`);
  }
  return [...vocab, { name, color: def.color, icon: def.icon }];
}

/**
 * Drop the vocab entry with this name (case-insensitive). Returns a new array.
 *
 * This is the LIST half only. Since #713 the editor never calls it to perform a
 * delete: `removeBusinessTag` does that server-side, because the assignments on
 * `kinfolk` / `kin` have to go with it and a client cannot guarantee that
 * fan-out finishes. This stays as the pure transform that keeps the on-screen
 * list in step once the callable has reported success.
 */
export function removeTag(vocab: TagDef[], name: string): TagDef[] {
  return vocab.filter((t) => !sameName(t.name, name));
}

/**
 * Change an existing tag's color and/or icon. The name is the key and is never
 * changed here (renaming would orphan assignments; v1 is remove + add instead),
 * so the patch only carries `color`/`icon`. Returns a new array.
 */
export function editTag(
  vocab: TagDef[],
  name: string,
  patch: Partial<Pick<TagDef, 'color' | 'icon'>>,
): TagDef[] {
  return vocab.map((t) =>
    sameName(t.name, name)
      ? {
          ...t,
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        }
      : t,
  );
}
