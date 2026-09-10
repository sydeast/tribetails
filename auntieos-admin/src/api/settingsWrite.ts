import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { call } from '../lib/fns';
import { BUSINESS_SETTINGS_DOC_ID, type BusinessSettings } from './settings';
import { type TagScope } from '../lib/tags/model';

/**
 * The Settings editor's write path, paired with `getBusinessSettings` in
 * `./settings.ts`.
 *
 * Verified against the wasm source directly (there is no callable to reach for,
 * same as the read side): `FirestoreInterop.wasmJs.kt#platformSaveBusinessSettings`
 * stamps `_id` + `updatedAt` onto the caller's settings object and writes it with
 * `jsSetDoc(..., merge: true)` (see `setDocOnce` in that file). `firestore.rules`
 * line 140-143 gates the doc `allow write: if isAuntie()`, so this is a direct
 * client SDK write, not a Cloud Function, exactly mirroring `getBusinessSettings`'s
 * direct `getDoc`.
 *
 * ONE DELIBERATE DEPARTURE from the wasm save function, and it is additive only:
 * the wasm stamps `updatedAt` but never `updatedBy`, despite `BusinessSettings`
 * carrying that field (`FirestoreClient.kt` line 2559) and the Settings overview
 * already rendering it (`lastSavedLabel`, `settingsFormat.ts`). Leaving it
 * unstamped here would mean "Last saved 07-17 14:02" forever loses the "by
 * Auntie" half after every admin edit. This stamps it from the signed-in user
 * (email, falling back to uid so a save is never left blank), which only adds
 * information the doc already has a field for; it changes no read path and no
 * existing behavior.
 *
 * A PARTIAL patch, not the whole document (the wasm side reconstructs and sends
 * the full object; this sends only the touched fields): `merge: true` deep-merges
 * a nested map field like `mytribePortal` rather than replacing it, so a caller
 * that touches one section's fields can never clobber a sibling section's data,
 * which is the same non-clobbering guarantee the wasm comment claims, achieved
 * with less data on the wire.
 *
 * Fail-loud: never swallows a write failure. A permission-denied, offline, or
 * network write error propagates to the caller (each section's Save handler in
 * `screens/settings/sections.tsx` and its sibling editors), which is the only
 * place that can show it beside the field the operator was actually editing.
 */
export interface SaveStamp {
  updatedAt: string;
  updatedBy: string;
}

export async function saveBusinessSettings(patch: Partial<BusinessSettings>): Promise<SaveStamp> {
  const updatedAt = new Date().toISOString();
  const updatedBy = auth.currentUser?.email ?? auth.currentUser?.uid ?? '';
  await setDoc(
    doc(db, 'business_settings', BUSINESS_SETTINGS_DOC_ID),
    { ...patch, updatedAt, updatedBy },
    { merge: true },
  );
  return { updatedAt, updatedBy };
}

/**
 * Deleting one tag, which is a CASCADE and therefore not a settings write.
 *
 * #713, operator ruling: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY."
 * Dropping the vocabulary row is only half of it; the tag has to come off every
 * `kinfolk` (household scope) or `kin` (pet scope) doc carrying it. That fan-out
 * cannot run from the client: it is an unbounded set of writes, and one that
 * half-finishes because a laptop slept leaves the directory in a state the
 * editor can no longer describe. `removeBusinessTag` does both halves server-side
 * and reports how many records it touched.
 *
 * Deliberately NOT routed through `saveBusinessSettings`: this is the one tag
 * edit that is not a local list edit waiting on Save. Every other change (add,
 * recolor, re-emoji) still batches into the Save button.
 *
 * Not marked idempotent for `call`'s retry (see CallOptions): the callable IS
 * safe to re-run, but a retry that lands after a lost reply would report a
 * second, smaller `recordsTouched` and the toast would understate what happened.
 * A visible failure the operator can press again is the honest outcome.
 */
export interface RemoveBusinessTagResult {
  ok: true;
  scope: TagScope;
  name: string;
  /** Households (or kin) the tag was stripped off. */
  recordsTouched: number;
  /** False when the vocabulary had already lost the row, e.g. a half-finished earlier delete. */
  vocabRemoved: boolean;
}

export async function removeBusinessTag(
  scope: TagScope,
  name: string,
): Promise<RemoveBusinessTagResult> {
  return call<{ scope: TagScope; name: string }, RemoveBusinessTagResult>('removeBusinessTag', {
    scope,
    name,
  });
}
