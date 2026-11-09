import { call, type CallOptions } from './fns';

/**
 * #1504, WARM ON INTENT: wake a save's Cloud Run instance when the household
 * opens the form that will call it.
 *
 * Every portal write is its own Cloud Run service with minInstances 0, so the
 * first save of the day pays a cold start (the 2026-11-01 walk read two to
 * four seconds of it behind the tool's own delay). The #1282 warm-up wakes the
 * screen READS when the portal opens, and a read shares no instance with its
 * save. So the form fires one call to its own save the moment it opens; by the
 * time the household has typed and pressed Save, that instance is up.
 *
 * The payload is exactly `{ __warm: true }`. `wrapCallable` on the server
 * (`functions/src/lib/wrapCallable.ts`) answers that payload, from a signed-in
 * caller, before the handler runs: nothing is read past the session check,
 * nothing is written, nobody is notified. Any other payload, including one with
 * the marker plus another key, is a real call.
 *
 * SILENT, like the #1282 reads. The call carries `{ background: true }`, so a
 * refusal can never be the thing that signs the household out; the save itself
 * is. Nothing here throws: a failure is logged to the console and dropped,
 * because the household asked for nothing and the save still works cold.
 *
 * Only the saves named in #1504 are warmed, plus the second half of the Tribe
 * Profile page save and the message composer's Send beside Polish.
 */
export const WARMABLE_SAVES = [
  'saveMyAccount',
  'saveTribeProfile',
  // The Tribe Profile page's Save writes this half too.
  'saveHomeAccess',
  'saveMyNotificationPrefs',
  'addBookingNote',
  'requestBooking',
  'addKin',
  'updateKin',
  'createShareLink',
  // The message composer: Polish, and Send beside it.
  'generate',
  'sendKinfolkMessage',
] as const;

export type WarmableSave = (typeof WARMABLE_SAVES)[number];

/** The whole warm payload. A real call never sends this shape. */
export const WARM_PAYLOAD: Readonly<{ __warm: true }> = Object.freeze({ __warm: true });

const BACKGROUND: CallOptions = { background: true };

/** Fires the warm call for [name]. Resolves whatever happens; never rejects. */
export async function warmSave(name: WarmableSave): Promise<void> {
  try {
    await call<{ __warm: true }, unknown>(name, { ...WARM_PAYLOAD }, BACKGROUND);
  } catch (err) {
    console.warn(`[warmSave] ${name} warm call failed; the save will run cold:`, err);
  }
}
