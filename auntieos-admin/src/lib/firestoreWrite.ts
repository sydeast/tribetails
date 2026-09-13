import {
  addDoc as fbAddDoc,
  deleteDoc as fbDeleteDoc,
  doc as fbDoc,
  setDoc as fbSetDoc,
  updateDoc as fbUpdateDoc,
} from 'firebase/firestore';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  SetOptions,
  UpdateData,
  WithFieldValue,
  WriteBatch,
} from 'firebase/firestore';
import { LostSignalError, isConnected, settleWrite } from './offlineWrite';

/**
 * The Firestore write functions, with the same names and the same signatures,
 * except that they stop waiting for an acknowledgement that cannot arrive.
 *
 * #807, admin side. `setDoc`/`updateDoc`/`addDoc`/`batch.commit()` all resolve
 * on SERVER ACK, so offline their promises never settle — not resolve, not
 * reject, ever. Fourteen modules under `api/` write this way, and every one of
 * their callers is `setBusy(true); await …; setBusy(false)`, so an operator who
 * saves anything with no signal watches "Saving…" for as long as the tab stays
 * open. That is the exact defect #807 names, arriving by a different road from
 * the portal's paused mutation.
 *
 * WHY A DROP-IN MODULE RATHER THAN AN EDIT PER CALL SITE. There are 28 write
 * sites across those 14 modules, most of them multi-line calls whose result is
 * read back. Wrapping each by hand is 28 chances to get a paren wrong in code
 * that moves money, and it leaves the NEXT direct write — written next month by
 * somebody who never read this issue — hanging exactly as before. Swapping the
 * import means a module either writes through this seam or does not, which is
 * one grep.
 *
 * OFFLINE AT THE TAP IS NOT THE ONLY OFFLINE. A device with one bar can lose it
 * a moment after the button is pressed, which on a job site is the common case
 * rather than the exotic one, and the promise that never settles is the same
 * promise either way. So `settleWrite` races the wait against the browser's
 * `offline` event rather than only checking before it starts. `addDoc` is
 * raced too, and is the one call that cannot answer "queued" when it loses:
 * see its own note.
 *
 * WHAT IT DOES NOT DO. It does not cancel anything, and it does not decide
 * anything is safe. The write is in Firestore's IndexedDB queue either way
 * (`lib/firestoreCache.ts` turns that on) and commits on reconnect, through a
 * browser restart. All that changes is that the UI stops pretending the server
 * has answered. Whether a given write is SAFE to arrive late is a separate
 * question, answered per callable in `lib/fns.ts`'s `idempotent` opt-in and, for
 * the money paths, in `components/InvoiceDetail.tsx` — not here.
 */

/**
 * What the banner calls a queued write, from the collection it lands in.
 *
 * The operator gets told which of their changes is still waiting, and "a write
 * to household_data" is not that. Anything unlisted falls back to the raw
 * segment, which is worse copy but never a lie, and is a visible prompt to add
 * a row here.
 */
const SUBJECTS: Record<string, string> = {
  clients: 'your account details',
  coverage_packages: 'a coverage package',
  household_data: 'household details',
  kin: 'a Kin',
  kin_care_reports: 'a KinTale',
  kin_care_sessions: 'a visit',
  kinfolk: 'a household',
  kintale_templates: 'a KinTale template',
  media_files: 'a media file',
  message_drafts: 'a message draft',
  settings: 'your settings',
  voicemails: 'a voicemail',
};

/**
 * The collection a reference sits in, which is every odd segment's parent.
 *
 * Takes `string | undefined` rather than `string`, and that is not defensive
 * padding. A real `DocumentReference` always carries `path`, but the reference
 * reaching this module is whatever the caller passed, and across the admin's
 * specs `doc()` is routinely stubbed with a bare object. A banner label is
 * never worth throwing inside somebody's save, so an unknown path gets a
 * truthful vague phrase instead of a crash.
 */
export function subjectOf(path: string | undefined): string {
  if (typeof path !== 'string' || path === '') return 'this change';
  const segments = path.split('/').filter((s) => s !== '');
  // A document path alternates collection/id, so the collection is the
  // second-to-last segment; a collection path ends on the collection itself.
  const collection = segments.length % 2 === 0 ? segments[segments.length - 2] : segments[segments.length - 1];
  return SUBJECTS[collection ?? ''] ?? (collection ?? 'this change');
}

/** Background writes nobody tapped. See `settleWrite`'s `silent` option. */
const SILENT_COLLECTIONS = new Set(['breadcrumbs']);

function opts(path: string | undefined): { silent?: boolean } {
  const last = (typeof path === 'string' ? path : '').split('/').filter((s) => s !== '');
  return SILENT_COLLECTIONS.has(last[last.length - 1] ?? '') ||
    SILENT_COLLECTIONS.has(last[last.length - 2] ?? '')
    ? { silent: true }
    : {};
}

export async function setDoc<T>(
  reference: DocumentReference<T>,
  data: WithFieldValue<T>,
  options?: SetOptions,
): Promise<void> {
  const write =
    options === undefined ? fbSetDoc(reference, data) : fbSetDoc(reference, data, options);
  await settleWrite(write, subjectOf(reference.path), opts(reference.path));
}

export async function updateDoc<T>(
  reference: DocumentReference<T>,
  data: UpdateData<T>,
): Promise<void> {
  // `fbUpdateDoc`'s two overloads (typed data, or a field/value varargs list)
  // make the generic one ambiguous to infer through a pass-through like this.
  // Narrowed to the typed overload deliberately: none of the fourteen callers
  // uses the varargs form, and widening it would let a new one in untested.
  const update = fbUpdateDoc as (ref: DocumentReference<T>, data: UpdateData<T>) => Promise<void>;
  await settleWrite(update(reference, data), subjectOf(reference.path), opts(reference.path));
}

/**
 * Add a document, returning its reference without waiting for a server that
 * cannot answer.
 *
 * ONLINE THIS IS FIREBASE'S OWN `addDoc`, UNCHANGED, and that is deliberate
 * rather than lazy. The two are equivalent — `addDoc` is `doc()` plus
 * `setDoc()` — but "equivalent" is a claim about Firestore's internals, and
 * this module has no business making it on the path that runs every day. What
 * it can say for itself is narrower and safer: when there is a connection,
 * nothing about this call is different from before.
 *
 * OFFLINE IT IS REBUILT, because there it has to be. Firebase's `addDoc`
 * resolves the DocumentReference only once the server has the write, so a
 * caller doing `const ref = await addDoc(…); return ref.id` waits forever for
 * an id that `doc(collection)` generated on the device before the call was
 * made. Minting it here returns it immediately and lets the write queue.
 */
export async function addDoc<T>(
  reference: CollectionReference<T>,
  data: WithFieldValue<T>,
): Promise<DocumentReference<T>> {
  if (!isConnected()) {
    const ref = fbDoc(reference);
    await settleWrite(fbSetDoc(ref, data), subjectOf(reference.path), opts(reference.path));
    return ref;
  }
  // ONLINE AT THE CALL IS NOT ONLINE FOR THE WHOLE WRITE, so this is raced the
  // same way `settleWrite` races the others. What it CANNOT do is the same
  // thing they do. They resolve "queued" and let the caller carry on; this one
  // owes its caller a DocumentReference, and the only id that would be correct
  // is the one inside the `addDoc` still in flight. Minting a second would
  // hand back a reference to a document that will never exist, which is worse
  // than any spinner. So the honest answer is that the outcome is unknown, and
  // `LostSignalError` is the word for that — the write itself still commits
  // from Firestore's queue on reconnect, under the id the caller never saw.
  const settled = await Promise.race([
    fbAddDoc(reference, data).then((ref) => ({ ref })),
    offlineDuringWrite(),
  ]);
  if ('ref' in settled) return settled.ref;
  throw new LostSignalError(subjectOf(reference.path));
}

/** Resolves when the browser reports the connection went, and not otherwise. */
function offlineDuringWrite(): Promise<{ offline: true }> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return;
    const onOffline = (): void => {
      window.removeEventListener('offline', onOffline);
      resolve({ offline: true });
    };
    window.addEventListener('offline', onOffline);
  });
}

export async function deleteDoc(reference: DocumentReference<DocumentData>): Promise<void> {
  await settleWrite(fbDeleteDoc(reference), subjectOf(reference.path), opts(reference.path));
}

/**
 * Commit a batch, or report it queued.
 *
 * A batch has no path of its own, so the caller names its subject. The one
 * place a phrase is written by hand rather than derived.
 */
export async function commitBatch(batch: WriteBatch, what: string): Promise<void> {
  await settleWrite(batch.commit(), what);
}
