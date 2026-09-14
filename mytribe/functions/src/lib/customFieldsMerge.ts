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
 *   - A sent key with no stored row is appended, in sent order. A key sent twice:
 *     the last copy wins.
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

function keyOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const key = (entry as { key?: unknown }).key;
  return typeof key === 'string' ? key : null;
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
    out.push(next);
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
