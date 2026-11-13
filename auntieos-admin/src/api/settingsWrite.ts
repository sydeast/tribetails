import { call } from '../lib/fns';
import { type BusinessSettings, decodeTagDefs } from './settings';
import { type TagChange, type TagDef, type TagScope } from '../lib/tags/model';
/**
 * The Settings editor's write path, paired with `getBusinessSettings` in
 * `./settings.ts`.
 *
 * #1593: a callable, `saveBusinessSettings`. This used to be a direct
 * `setDoc(..., { merge: true })` on `business_settings/business_settings`, with
 * the Firestore rules as the only server check, and the 2026-11-05 QA walk
 * saved a price of "abc" and a close before the open through it. The server now
 * checks every field (`mytribe/functions/src/lib/businessSettingsChecks.ts`,
 * mirrored for the screens in `lib/settingsChecks.ts`) and the rules deny the
 * document to every client, so this is the only way in.
 *
 * A PARTIAL patch, as before: only the touched fields travel. The server keeps
 * the write shape the direct write had: nested maps such as `mytribePortal`
 * merge key by key, so one section's save never clobbers another's, and the
 * KinCare rate card (`serviceRates`, `serviceDurations`,
 * `serviceStartTimeBooking`) replaces what is stored, so a removed type goes.
 *
 * The server stamps `updatedAt` and `updatedBy` (the caller's uid, #1962) and
 * answers with both, which `Settings.tsx` folds onto its baseline. The screen
 * shows the person's name for that uid (`lib/actorLabel.ts`).
 *
 * Fail-loud: a refusal rejects with the server's sentence as `message`, and
 * `details.refusals` lists each `{ field, message }` (`settingsRefusalsOf` in
 * `lib/settingsChecks.ts`). Each section's Save handler shows it.
 */
export interface SaveStamp {
  updatedAt: string;
  updatedBy: string;
}
export async function saveBusinessSettings(patch: Partial<BusinessSettings>): Promise<SaveStamp> {
  // A key with no value is not a change; the server refuses one by name.
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return call<{ changes: Record<string, unknown> }, SaveStamp>('saveBusinessSettings', { changes });
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
 * edit that does not wait on Save. Adds and recolours batch into the Save
 * button and go out through `changeBusinessTags` above.
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

/**
 * #2205: adds and recolours tags one named tag at a time, against the list AS
 * STORED. Before this, "add to your tags" and the Tags editor's Save sent the
 * whole list as the screen had read it, and the settings save replaced the
 * stored list with it: a tag added on another device was lost and a deleted
 * one came back. `saveBusinessSettings` now refuses a changed tag list.
 *
 * All the changes apply in one transaction or none do. A refusal carries the
 * server's sentence as `message` ("A "VIP" tag already exists.", or "The tag
 * list changed since this screen opened ... Reload and try again.").
 *
 * Answers with both lists as stored after the write, decoded the way the
 * settings read decodes them, so the screen repaints from what the server has.
 *
 * Not marked idempotent for `call`'s retry: a retried add that landed the
 * first time is refused as a duplicate, which would read as a failure.
 */
export interface TagListsAfterChange {
  householdTags: TagDef[];
  petTags: TagDef[];
}

export async function changeBusinessTags(changes: TagChange[]): Promise<TagListsAfterChange> {
  const res = await call<{ changes: TagChange[] }, { householdTags?: unknown; petTags?: unknown }>(
    'changeBusinessTags',
    { changes },
  );
  return { householdTags: decodeTagDefs(res?.householdTags), petTags: decodeTagDefs(res?.petTags) };
}
