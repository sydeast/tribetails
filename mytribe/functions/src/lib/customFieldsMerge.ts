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
 * Rows accepted in one request, and keys in one `removeCustomFieldKeys`: the
 * growth ceiling divided by the smallest row (1,985).
 *
 * Current clients send every stored row back, so the request cap must admit any
 * list the server can have written. Growth past the ceiling is refused, and more
 * rows than this cannot fit under it, so no list written here is longer. It is
 * below the 10,009 rows the form schemas could name (50 sections of 200 fields
 * plus 9 reserved rows). That is fine: that many rows would outweigh the ceiling
 * anyway, so the byte budget is the binding limit.
 */
export const CUSTOM_FIELDS_MAX_ROWS = Math.floor(CUSTOM_FIELDS_GROWTH_MAX_BYTES / SMALLEST_ROW_JSON_BYTES);

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
export const CustomFieldsZ = z.array(CustomFieldZ).max(CUSTOM_FIELDS_MAX_ROWS);
export const RemoveCustomFieldKeysZ = z.array(z.string().min(1).max(CUSTOM_FIELD_KEY_MAX)).max(CUSTOM_FIELDS_MAX_ROWS);

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
 * The merge both callables run inside their transaction, with its two refusals.
 * Throws before anything is written.
 *
 * The size refusal fires only when the save GROWS the list past the growth
 * ceiling (or the document backstop). A household already over it (written
 * before this check, or by another writer)
 * can still echo, clear, remove, and make edits that add no bytes, because refusing those would
 * lock it out of every save over rows it has no way to see or delete.
 */
export function mergeCustomFieldsForSave(stored: unknown, sent: readonly CustomFieldRow[], removeKeys: readonly string[]): unknown[] {
  const unlabeled = newKeysMissingLabel(stored, sent, removeKeys);
  if (unlabeled.length > 0) {
    throw new HttpsError('invalid-argument', `A new custom field needs a label: ${unlabeled.join(', ')}.`);
  }
  const merged = mergeCustomFields(stored, sent, removeKeys);
  const bytes = customFieldsBytes(merged);
  const grows = bytes > customFieldsBytes(stored);
  if (grows && (bytes > CUSTOM_FIELDS_HARD_MAX_BYTES || bytes > CUSTOM_FIELDS_GROWTH_MAX_BYTES)) {
    throw new HttpsError('invalid-argument', 'These details are too large to save. Shorten or remove some fields, then save again.');
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
