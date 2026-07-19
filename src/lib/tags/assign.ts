import { normalizeTagName, type TagDef } from './model';

/**
 * Pure helpers for the assign field: turning a text query into vocab
 * suggestions, and adding/removing an assigned tag NAME. No React; the field
 * component is a thin shell over these, and they are unit-tested on their own.
 * Every name comparison is case-insensitive on the normalized name, the same
 * rule the vocabulary model uses.
 */

function key(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/**
 * Suggest vocabulary tags for an autocomplete query, excluding tags already
 * assigned. Prefix matches rank before substring matches; an empty query
 * returns every not-yet-assigned tag (so focusing the field shows the whole
 * vocabulary to pick from). Never mutates its inputs.
 */
export function suggestTags(input: string, vocab: TagDef[], already: string[]): TagDef[] {
  const assigned = new Set(already.map(key));
  const pool = vocab.filter((t) => !assigned.has(key(t.name)));
  const q = key(input);
  if (q === '') return pool;
  const starts = pool.filter((t) => key(t.name).startsWith(q));
  const contains = pool.filter((t) => !key(t.name).startsWith(q) && key(t.name).includes(q));
  return [...starts, ...contains];
}

/**
 * Add a tag name to the assigned list: normalized, and deduped
 * case-insensitively (so "vip" is not added beside an existing "VIP"). A blank
 * name is a no-op. Returns a new array.
 */
export function addAssigned(already: string[], name: string): string[] {
  const n = normalizeTagName(name);
  if (n === '') return already;
  if (already.some((x) => key(x) === key(n))) return already;
  return [...already, n];
}

/** Remove a tag name from the assigned list (case-insensitive). Returns a new array. */
export function removeAssigned(already: string[], name: string): string[] {
  const k = key(name);
  return already.filter((x) => key(x) !== k);
}
