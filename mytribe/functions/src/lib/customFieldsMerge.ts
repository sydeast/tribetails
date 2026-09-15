import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

/**
 * #873: `customFields` on `families/{id}` and `families/{id}/homeAccess/current`
 * merge by key. Contract in CALLABLE_CONTRACT.md, "saveTribeProfile /
 * saveHomeAccess".
 *
 * WHY. Both callables used to replace the stored list whole. The portal clients,
 * when an admin had authored a form schema, rebuilt the list from the schema's
 * keys alone, so every stored row outside the schema (office-set rows shown as
 * "Set by your Auntie", rows from an older schema, hand-added rows) was deleted
 * on the household's next save. Old installs and cached bundles keep sending
 * that schema-only list, so the fix has to live on the server: a row the client
 * did not send is kept.
 *
 * THE RULES.
 *   - A sent row replaces the stored row with the same key, in the stored row's
 *     position. Later stored copies of that key are folded into it.
 *   - A sent row with a blank label keeps the stored row's label. Current clients
 *     echo every stored row, and getMyTribeProfile serves a missing label as ''.
 *   - A sent key with no stored row is appended, in sent order. A key sent twice:
 *     the last copy wins. It must carry a label (see `newKeysMissingLabel`).
 *   - A sent `value: ''` is a real clear. The row stays, with an empty value.
 *     A sent '' for a key with no stored row writes nothing.
 *   - A stored row is removed only when its key is in `removeKeys`.
 *   - A stored entry with no string `key` is carried through verbatim: nothing
 *     here deletes what it cannot read.
 */

export interface CustomFieldRow {
  key: string;
  label: string;
  value: string;
}

/*
 * SIZES are UTF-8 bytes of the list's JSON, never string length: an emoji is 2
 * UTF-16 units and 4 bytes, and Firestore charges bytes. JSON over-counts
 * Firestore's own size rule (a string costs its UTF-8 bytes plus 1, a map field
 * its name plus its value), so a budget measured this way is on the safe side.
 */

/**
 * The growth ceiling (#873 second review). A save may not GROW the list past
 * 64 KiB. A household list is a few dozen short rows, so this is far above any
 * real one, and it keeps a runaway client or a script well away from the
 * document limit. A save that does not grow the list is never refused, so a
 * household already over 64 KiB can still echo, clear, remove, and make edits
 * that add no bytes.
 */
export const CUSTOM_FIELDS_GROWTH_MAX_BYTES = 64 * 1024;

/**
 * The document backstop. Firestore's 1 MiB document limit is the real ceiling;
 * 900 KiB leaves about 124 KiB for displayName, gate codes and timestamps beside
 * the list. It is applied the same way as the growth ceiling (only to a save that
 * grows the list), so while that ceiling sits below it this check cannot fire on
 * its own. It is here so that raising the growth ceiling can never raise the
 * list past the document.
 */
export const CUSTOM_FIELDS_HARD_MAX_BYTES = 900 * 1024;

/** `{"key":"a","label":"","value":""}`: the smallest row a client can send. */
export const SMALLEST_ROW_JSON_BYTES = 33;

/**
 * The row cap, 1,985: the growth ceiling divided by the smallest row. It bounds
 * what ONE SAVE may change, never how many rows a client sends (#873 final
 * review). Checked inside the transaction, against the stored list:
 *   - rows that differ from the stored row with the same key, plus new keys that
 *     would land, may not exceed it (`changedRowCount`);
 *   - the merged list may not exceed it AND be longer than the stored one.
 * A household migrated with more rows than this still saves: its client sends
 * every stored row back, and only the few it edited count.
 */
export const CUSTOM_FIELDS_MAX_ROWS = Math.floor(CUSTOM_FIELDS_GROWTH_MAX_BYTES / SMALLEST_ROW_JSON_BYTES);

/**
 * The callable request body limit this guard relies on. ASSUMED at 10 MiB, the
 * figure for callable requests; a larger real limit only means some oversized
 * bodies are refused by this parse instead of the transport, and any figure far
 * above a 1 MiB document works.
 */
export const CALLABLE_BODY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Rows, and `removeCustomFieldKeys` entries, a request may carry at all
 * (317,750): no body under the transport limit holds more smallest rows. A
 * parse-time guard against a junk request. It is far above anything a Firestore
 * document can store, so a client sending a real stored list back is never
 * refused here; what a save may CHANGE is bounded by CUSTOM_FIELDS_MAX_ROWS.
 */
export const CUSTOM_FIELDS_REQUEST_MAX_ROWS = Math.floor(CALLABLE_BODY_MAX_BYTES / SMALLEST_ROW_JSON_BYTES);

/**
 * Saves per household per hour, for each of saveTribeProfile and saveHomeAccess
 * (#873 second review). Each callable has its OWN bucket: one page Save calls
 * both, so a shared bucket would allow 30 clicks an hour, and a click landing on
 * its edge would save the profile and refuse the home details.
 */
export const PROFILE_SAVE_RATE_LIMIT = { max: 60, windowSecs: 3600 } as const;

/** Matches `saveFormSchema`'s field key, which is what clients send as a row key. */
export const CUSTOM_FIELD_KEY_MAX = 80;
/**
 * Matches `saveFormSchema`'s field label (`plaintext(200)`). Clients send the
 * schema label, so the old 80 refused every save once an admin wrote a longer one.
 */
export const CUSTOM_FIELD_LABEL_MAX = 200;
export const CUSTOM_FIELD_VALUE_MAX = 1000;

/**
 * The label may be blank: on a stored key the stored label is kept, and a blank
 * label on a new key is refused after the stored list is read, where the two
 * cases can be told apart.
 */
export const CustomFieldZ = z.object({
  key: z.string().min(1).max(CUSTOM_FIELD_KEY_MAX),
  label: z.string().max(CUSTOM_FIELD_LABEL_MAX),
  value: z.string().max(CUSTOM_FIELD_VALUE_MAX),
});
export const CustomFieldsZ = z.array(CustomFieldZ).max(CUSTOM_FIELDS_REQUEST_MAX_ROWS);
export const RemoveCustomFieldKeysZ = z.array(z.string().min(1).max(CUSTOM_FIELD_KEY_MAX)).max(CUSTOM_FIELDS_REQUEST_MAX_ROWS);

function keyOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const key = (entry as { key?: unknown }).key;
  return typeof key === 'string' ? key : null;
}

function isBlank(label: string): boolean {
  return label.trim() === '';
}

function storedLabel(entry: unknown): string {
  const label = (entry as { label?: unknown }).label;
  return typeof label === 'string' ? label : '';
}

export function mergeCustomFields(
  stored: unknown,
  sent: readonly CustomFieldRow[],
  removeKeys: readonly string[],
): unknown[] {
  const base: unknown[] = Array.isArray(stored) ? stored : [];
  const remove = new Set(removeKeys);
  const latest = new Map<string, CustomFieldRow>();
  for (const row of sent) latest.set(row.key, { key: row.key, label: row.label, value: row.value });

  const placed = new Set<string>();
  const out: unknown[] = [];
  for (const entry of base) {
    const key = keyOf(entry);
    if (key === null) {
      out.push(entry);
      continue;
    }
    if (remove.has(key)) continue;
    const next = latest.get(key);
    if (next === undefined) {
      out.push(entry);
      continue;
    }
    if (placed.has(key)) continue;
    out.push(isBlank(next.label) ? { ...next, label: storedLabel(entry) } : next);
    placed.add(key);
  }
  for (const row of latest.values()) {
    if (placed.has(row.key) || remove.has(row.key)) continue;
    // An old client sends '' for a schema field it never had a value for. Over
    // nothing stored that is not a clear, so no empty row is written.
    if (row.value === '') continue;
    out.push(row);
    placed.add(row.key);
  }
  return out;
}

/**
 * Sent keys that would land as a NEW row with a blank label.
 *
 * No client builds one: web and Android fall back to the key when the schema
 * label is blank, old clients send the schema label (`min(1)` in saveFormSchema)
 * or a fixed card label, and a blank label only ever arrives as an echo of a
 * stored row, which keeps its stored label. So a blank label on a new key is a
 * client bug, refused rather than stored as a row nobody can read. A row that
 * would not land (value '', or named for removal) is never refused.
 */
export function newKeysMissingLabel(stored: unknown, sent: readonly CustomFieldRow[], removeKeys: readonly string[]): string[] {
  const storedKeys = new Set((Array.isArray(stored) ? stored : []).map(keyOf).filter((k): k is string => k !== null));
  const remove = new Set(removeKeys);
  const latest = new Map<string, CustomFieldRow>();
  for (const row of sent) latest.set(row.key, row);
  return [...latest.values()]
    .filter((r) => !storedKeys.has(r.key) && !remove.has(r.key) && r.value !== '' && isBlank(r.label))
    .map((r) => r.key);
}

/** UTF-8 bytes of the list's JSON; see SIZES above. */
export function customFieldsBytes(list: unknown): number {
  return Buffer.byteLength(JSON.stringify(Array.isArray(list) ? list : []), 'utf8');
}

/**
 * How many rows this save really changes (#873 final review): sent rows that
 * differ from the stored row with the same key (value, or a label that is not
 * blank, since a blank label keeps the stored one), plus new keys that would land
 * (value not '', not removed). An unchanged echo of a stored row costs nothing,
 * and a removal is not counted (it only shrinks the list).
 */
export function changedRowCount(stored: unknown, sent: readonly CustomFieldRow[], removeKeys: readonly string[]): number {
  const first = new Map<string, unknown>();
  for (const entry of Array.isArray(stored) ? stored : []) {
    const key = keyOf(entry);
    if (key !== null && !first.has(key)) first.set(key, entry);
  }
  const remove = new Set(removeKeys);
  const latest = new Map<string, CustomFieldRow>();
  for (const row of sent) latest.set(row.key, row);
  let changed = 0;
  for (const row of latest.values()) {
    if (remove.has(row.key)) continue;
    const current = first.get(row.key);
    if (current === undefined) {
      if (row.value !== '') changed += 1;
      continue;
    }
    const value = (current as { value?: unknown }).value;
    if (value !== row.value || (!isBlank(row.label) && row.label !== storedLabel(current))) changed += 1;
  }
  return changed;
}

/** True when the merged list is exactly what is stored (a missing list reads as empty). */
export function sameAsStored(merged: readonly unknown[], stored: unknown): boolean {
  return JSON.stringify(merged) === JSON.stringify(Array.isArray(stored) ? stored : []);
}

/**
 * The merge both callables run inside their transaction, with its refusals.
 * Throws before anything is written.
 *
 * Every size refusal fires only when the save GROWS the list, in bytes or in
 * rows, or changes more rows at once than the cap. A household already over a
 * limit (migrated, written before these checks, or by another writer) can still
 * echo its whole list, edit a few rows, clear and remove, because refusing those
 * would lock it out of every save over rows it has no way to see or delete.
 */
export function mergeCustomFieldsForSave(stored: unknown, sent: readonly CustomFieldRow[], removeKeys: readonly string[]): unknown[] {
  const unlabeled = newKeysMissingLabel(stored, sent, removeKeys);
  if (unlabeled.length > 0) {
    throw new HttpsError('invalid-argument', `A new custom field needs a label: ${unlabeled.join(', ')}.`);
  }
  if (changedRowCount(stored, sent, removeKeys) > CUSTOM_FIELDS_MAX_ROWS) {
    throw new HttpsError('invalid-argument', 'Too many fields changed in one save. Save fewer changes at a time.');
  }
  const merged = mergeCustomFields(stored, sent, removeKeys);
  const bytes = customFieldsBytes(merged);
  const grows = bytes > customFieldsBytes(stored);
  if (grows && (bytes > CUSTOM_FIELDS_HARD_MAX_BYTES || bytes > CUSTOM_FIELDS_GROWTH_MAX_BYTES)) {
    throw new HttpsError('invalid-argument', 'These details are too large to save. Shorten or remove some fields, then save again.');
  }
  // #873 final review: a save that shrinks a few huge rows could otherwise add
  // many small keys without growing bytes. Row count may not grow past the cap.
  const storedRows = Array.isArray(stored) ? stored.length : 0;
  if (merged.length > CUSTOM_FIELDS_MAX_ROWS && merged.length > storedRows) {
    throw new HttpsError('invalid-argument', 'This household has too many fields to add more. Remove some, then save again.');
  }
  return merged;
}

/** Keys a caller both sent and named for removal. A client bug, refused rather than guessed at. */
export function conflictingCustomFieldKeys(sent: readonly CustomFieldRow[] | undefined, removeKeys: readonly string[] | undefined): string[] {
  if (!sent || !removeKeys) return [];
  const remove = new Set(removeKeys);
  return [...new Set(sent.map((r) => r.key).filter((k) => remove.has(k)))];
}

/** True for a stored entry whose key is in [keys]. */
export function hasKeyIn(entry: unknown, keys: ReadonlySet<string>): boolean {
  const key = keyOf(entry);
  return key !== null && keys.has(key);
}
