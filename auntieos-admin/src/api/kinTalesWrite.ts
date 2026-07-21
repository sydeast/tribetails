import { addDoc, arrayUnion, collection, doc, increment, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getAuthState } from '../lib/auth';

/**
 * The write-side counterpart to `api/kinTales.ts` (list/read only). Confirmed
 * against three independent sources, not assumed from the Kotlin model alone:
 *
 *  - `firestore.rules:181`, `match /kin_care_reports/{reportId}`, `allow
 *    create: if isAuntie() || testOwnsIncoming()` / `allow update: if
 *    isAuntie() || testOwnsExisting()`: an admin writes this collection
 *    DIRECTLY from the client SDK. There is no `createKinTaleReport` /
 *    `updateKinTaleReport` / `sendKinTale` Cloud Function anywhere in
 *    MyTribe/functions/src; the backend only REACTS to these client writes via
 *    Firestore triggers (`onKinTaleCreate.ts` fires the `kintale.published`
 *    notification on every create, `onKinTaleUpdate.ts` fires
 *    `kintale.note.added` for a post-send edit, both intentionally skip the
 *    DRAFT->SENT transition itself).
 *  - `FirestoreInterop.wasmJs.kt#platformCreateKinTaleReport` /
 *    `#platformUpdateKinTaleReport`, the wasm's real writers: `addDoc`/`setDoc`
 *    on `kin_care_reports`, stamping `createdAt`/`updatedAt` via a
 *    client-computed ISO string (`nowIsoUtc()`), never
 *    `FieldValue.serverTimestamp()`, matching every other date field already
 *    documented as opaque text in `api/kinTales.ts`.
 *  - `firebase-bridge.js`'s `markKinTaleReportSent`, the send transition: one
 *    `writeBatch` that (1) flips the report to `SENT` with `sentAt`/`sentVia`/
 *    `deliveryReceiptId` and (2) updates the PARENT `kin_care_sessions` doc
 *    (`reportIds: arrayUnion`, `sentReportCount: increment(1)`,
 *    `autoCompleteEligible: true`), atomically, so two concurrent sends can't
 *    clobber the session's running totals (the wasm client's own NOTE-52/W15
 *    comment on `FirestoreClient.kt#markKinTaleReportSent`).
 *
 * DELIBERATE DIVERGENCE from the wasm on UPDATE: the wasm always overwrites
 * the WHOLE document (`setDoc` with the client's complete in-memory
 * `KinCareReport`, every field, because that object is what it read the doc
 * into in the first place). This screen's `KinTaleDraft` is a deliberate
 * SUBSET (the `KinTaleEntry`/`SessionEntry` "subset type, not a blind mirror"
 * convention already used by the read side): it does not carry
 * `fieldResponses`/`petMoodSelections`/`formValues`/the orphan-triage fields,
 * because this compose surface doesn't render them. `setDoc`-ing that subset
 * WITHOUT `{ merge: true }` would silently ERASE those fields on every save,
 * a worse defect than anything the AO-12/AO-18 fixes document elsewhere
 * (silent data loss, not just a display mistake). `{ merge: true }` is the
 * fix: only the fields this screen actually edits are touched, on both
 * create and update.
 */

export interface KinTaleDraft {
  /** Absent on a not-yet-created draft; the compose screen scaffolds a blank one from a session. */
  _id?: string;
  /**
   * REQUIRED even on create, unlike the read-side `KinTaleEntry`: the send
   * transition below has to reach the parent `kin_care_sessions` doc, so a
   * draft with no `sessionId` could never be sent, only ever saved.
   */
  sessionId: string;
  kinfolkId: string;
  kinfolkName: string;
  kinIds: string[];
  serviceType: string;
  /** Free-text ISO instant, same caveat as `KinTaleEntry.visitDate`. */
  visitDate: string;
  /** Same caveat. */
  arrivedAt: string;
  title: string;
  /**
   * True when Auntie's generator wrote this title and the operator has not
   * replaced it. Mirrors the field MyTribe's backfill stamps
   * (`aiBatchPollCron.ts` writes `titleGeneratedByAi: true`), so a title's
   * provenance reads the same whether it was written live at compose time or
   * filled in later by the cron.
   *
   * The generator sets it ONLY over a blank title, and any keystroke in the
   * headline field clears it back to false. An operator's own words are never
   * labelled as the machine's.
   */
  titleGeneratedByAi: boolean;
  bodyCopy: string;
  mediaFileIds: string[];
}

/**
 * True when a draft has enough real content to be worth persisting or
 * sending. Mirrors the wasm composer's own `hasContent()` gate
 * (`KinTaleComposeScreen.kt`): an empty draft never round-trips to Firestore
 * just because the screen opened, and Send stays disabled until there's
 * something to send. Narrower than the wasm's version on purpose: this
 * compose surface doesn't carry `fieldResponses`/`petMoodSelections`/
 * `formValues`, so only the fields it actually edits count toward "has
 * content".
 */
export function hasKinTaleContent(draft: Pick<KinTaleDraft, 'title' | 'bodyCopy' | 'mediaFileIds'>): boolean {
  return draft.title.trim() !== '' || draft.bodyCopy.trim() !== '' || draft.mediaFileIds.length > 0;
}

/**
 * Create or update the draft. Returns the report id on a real write, or
 * `null` when there's nothing worth saving yet (a still-blank new draft),
 * same "no ghost row in Firestore" guard the wasm's own `persistDraft()`
 * applies before ever calling create/update.
 *
 * CREATE stamps `authorId`/`authorDisplayName` off the signed-in admin
 * (falling back to "Auntie", the wasm's own fallback, when the account has no
 * display name) plus `createdAt`/`updatedAt`. UPDATE only restamps
 * `updatedAt`, via `{ merge: true }` (see the file header for why merge, not
 * a full overwrite). Both use a client-computed ISO string, mirroring
 * `nowIsoUtc()`, never `serverTimestamp()`, matching every other field on
 * this doc.
 */
export async function saveKinTaleDraft(draft: KinTaleDraft): Promise<string | null> {
  if (!hasKinTaleContent(draft)) return draft._id ?? null;
  const now = new Date().toISOString();

  const fields = {
    sessionId: draft.sessionId,
    kinfolkId: draft.kinfolkId,
    kinfolkName: draft.kinfolkName,
    kinIds: draft.kinIds,
    serviceType: draft.serviceType,
    visitDate: draft.visitDate,
    arrivedAt: draft.arrivedAt,
    title: draft.title,
    titleGeneratedByAi: draft.titleGeneratedByAi,
    bodyCopy: draft.bodyCopy,
    mediaFileIds: draft.mediaFileIds,
  };

  if (draft._id === undefined || draft._id === '') {
    const auth = getAuthState();
    const authorId = auth.status === 'signedIn' ? auth.user.uid : '';
    const authorDisplayName = (auth.status === 'signedIn' ? auth.user.displayName : null)?.trim() || 'Auntie';
    const ref = await addDoc(collection(db, 'kin_care_reports'), {
      ...fields,
      status: 'DRAFT',
      sentAt: '',
      sentVia: '',
      authorId,
      authorDisplayName,
      createdAt: now,
      updatedAt: now,
    });
    return ref.id;
  }

  await setDoc(doc(db, 'kin_care_reports', draft._id), { ...fields, updatedAt: now }, { merge: true });
  return draft._id;
}

export interface SendKinTaleInput {
  reportId: string;
  sessionId: string;
}

/**
 * The send transition: `kin_care_reports/{reportId}` flips DRAFT -> SENT, and
 * `kin_care_sessions/{sessionId}` records the send, atomically (one
 * `writeBatch`), mirroring `firebase-bridge.js#markKinTaleReportSent`
 * exactly.
 *
 * `sentVia: 'pending'` and `deliveryReceiptId: ''` are the SAME placeholder
 * values the wasm composer's own `onSend()` sends, never a fabricated
 * channel/id: per its doc comment, "the backend pipeline overwrites with
 * sms/email/fcm" once actual delivery is attempted. This makes the identical
 * honest claim, no more.
 *
 * Fail-loud on a blank id (mirrors the wasm's own `require()` guards in
 * `platformMarkKinTaleReportSent`): a send with nowhere to route the
 * session-side update throws rather than silently committing half of the
 * transition.
 */
export async function sendKinTale(input: SendKinTaleInput): Promise<void> {
  if (input.reportId.trim() === '') throw new Error('sendKinTale requires a non-blank reportId');
  if (input.sessionId.trim() === '') throw new Error('sendKinTale requires a non-blank sessionId');

  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.update(doc(db, 'kin_care_reports', input.reportId), {
    status: 'SENT',
    sentAt: now,
    sentVia: 'pending',
    deliveryReceiptId: '',
    updatedAt: now,
  });
  batch.update(doc(db, 'kin_care_sessions', input.sessionId), {
    reportIds: arrayUnion(input.reportId),
    sentReportCount: increment(1),
    autoCompleteEligible: true,
    updatedAt: now,
  });
  await batch.commit();
}
