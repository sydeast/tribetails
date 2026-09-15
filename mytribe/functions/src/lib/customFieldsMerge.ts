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

/**
 * Size budget for the merged list, as UTF-8 bytes of its JSON.
 *
 * Firestore's 1 MiB document limit is the real ceiling, not a row count. JSON is
 * a conservative stand-in for Firestore's own size rule (a string costs its UTF-8
 * bytes plus 1, a map field its name plus its value): every quote, colon and
 * comma JSON adds is overhead Firestore does not charge. 900 KiB leaves about
 * 124 KiB of the document for displayName, gate codes, timestamps and whatever
 * else sits beside the list.
 */
export const CUSTOM_FIELDS_MAX_BYTES = 900 * 1024;

/** `{"key":"a","label":"","value":""}`: the smallest row a client can send. */
const SMALLEST_ROW_JSON_BYTES = 33;

/**
 * Rows accepted in one request, and keys in one `removeCustomFieldKeys`.
 *
 * WHY THIS NUMBER (27,927). Current clients send every stored row back, so the
 * request cap must admit any list the server can have stored, or one household
 * past the cap can never save again. Growth past `CUSTOM_FIELDS_MAX_BYTES` is
 * refused, so no list written here holds more than this many rows. It also sits
 * above what the form schemas can produce: `saveFormSchema` allows 50 sections of
 * 200 fields (10,000 keys) plus 9 reserved vet, after-hours and Emergency Contact
 * rows. A row-count cap derived from the schema alone would not hold, because
 * office rows and rows from older schemas are unbounded and cannot be deleted
 * from a client that no longer shows them. It is a guard against a junk request,
 * never the limit a household meets: the byte budget is.
 */
export const CUSTOM_FIELDS_MAX_ROWS = Math.floor(CUSTOM_FIELDS_MAX_BYTES / SMALLEST_ROW_JSON_BYTES);

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

/** UTF-8 bytes of the list's JSON; see `CUSTOM_FIELDS_MAX_BYTES`. */
export function customFieldsBytes(list: unknown): number {
  return Buffer.byteLength(JSON.stringify(Array.isArray(list) ? list : []), 'utf8');
}

/**
 * The merge both callables run inside their transaction, with its two refusals.
 * Throws before anything is written.
 *
 * The size refusal fires only when the save GROWS the list past the budget. A
 * household already over it (written before this check, or by another writer)
 * can still echo, edit in place, clear and remove, because refusing those would
 * lock it out of every save over rows it has no way to see or delete.
 */
export function mergeCustomFieldsForSave(stored: unknown, sent: readonly CustomFieldRow[], removeKeys: readonly string[]): unknown[] {
  const unlabeled = newKeysMissingLabel(stored, sent, removeKeys);
  if (unlabeled.length > 0) {
    throw new HttpsError('invalid-argument', `A new custom field needs a label: ${unlabeled.join(', ')}.`);
  }
  const merged = mergeCustomFields(stored, sent, removeKeys);
  const bytes = customFieldsBytes(merged);
  if (bytes > CUSTOM_FIELDS_MAX_BYTES && bytes > customFieldsBytes(stored)) {
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
