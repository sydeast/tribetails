import type { Timestamp } from 'firebase/firestore';
import { type CollectionSpec } from '../lib/firestore';

/**
 * The READ half of a KinCare visit's two note threads. The write half lives in
 * `api/bookingsWrite.ts` (`addBookingNote` / `addInternalBookingNote`), because
 * both are callables while these are direct client listens.
 *
 * TWO SUBCOLLECTIONS, NOT ONE COLLECTION WITH A FLAG, and that distinction is
 * enforced by `mytribe/firestore.rules`, not by convention:
 *
 *   families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes
 *     allow read: if activeMember(fid) || isAuntie();   allow write: if false;
 *   families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/internalNotes
 *     allow read: if isAuntie();                        allow write: if false;
 *
 * The kinfolk boundary is drawn at the PATH so no field masking is needed: a
 * household member simply cannot reach `internalNotes`. Both are write-denied
 * to every client, which is why adding a note goes through a callable.
 *
 * ENVELOPE IDS ARE REQUIRED. The path needs `batchId` + `visitId`, which only
 * sessions created by `approveBookingSeriesCore.ts` carry (as
 * `kinCareBatchId` / `kinCareVisitId`). A legacy flat session has no
 * resolvable notes path from the client at all, so the sheet says so rather
 * than rendering two convincing empty threads.
 *
 * ARCHIVE BUG NOT PORTED: `FirestoreInterop.wasmJs.kt#platformBookingNotesStream`
 * defaults `visitId` to blank, and `BookingDetailModal.kt` never passed one, so
 * the wasm admin READ `families/{k}/bookings/{bookingId}/notes` while
 * `addBookingNote` (which resolves through `resolveKinCareRef`) WROTE to
 * `.../kinCares/{visitId}/notes`. Notes saved there were never displayed back.
 * This port reads the nested path the server actually writes.
 */
export interface BookingNoteEntry {
  _id: string;
  /** Sanitised rich text (`sanitizeRichText` server-side). */
  body?: string | undefined;
  /** `'admin'` or `'kinfolk'`, stamped by the callable from the caller's role. */
  authorRole?: string | undefined;
  authorUid?: string | undefined;
  /** `FieldValue.serverTimestamp()` server-side, so a Timestamp on a settled
   *  doc, but briefly null and (on legacy rows) plain ISO text. */
  createdAt?: Timestamp | string | null | undefined;
}

/** How many notes one thread renders. A visit's thread is a handful of lines;
 *  the cap exists so this is a bounded listener like every other (AO-29). */
const NOTES_MAX = 100;

/**
 * The bounded, server-ordered listener for one thread.
 *
 * Ordered by `createdAt` ascending so the newest note lands at the bottom, the
 * way a thread reads. `sortNotes` re-derives the display order client-side
 * anyway (a note whose server timestamp has not landed yet sorts as 0 and would
 * otherwise be dropped from an `orderBy`-only view).
 *
 * No `filters`, so no composite index is needed.
 */
export function bookingNotesQuery(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  internal: boolean,
): CollectionSpec {
  const sub = internal ? 'internalNotes' : 'notes';
  return {
    path: `families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}/${sub}`,
    order: ['createdAt', 'asc'],
    max: NOTES_MAX,
  };
}

/** The note text, or '' for a partial doc. Never throws in render. */
export function noteBody(note: BookingNoteEntry): string {
  return typeof note.body === 'string' ? note.body : '';
}

/** Who wrote it, in operator language. `Unknown` rather than a blank byline. */
export function noteAuthorLabel(note: BookingNoteEntry): string {
  switch (note.authorRole) {
    case 'admin':
      return 'Auntie';
    case 'kinfolk':
      return 'Kinfolk';
    default:
      return 'Unknown';
  }
}

/**
 * Epoch ms for a note, whichever shape `createdAt` arrived in (Timestamp on a
 * settled doc, ISO text on a legacy one, absent while the server stamp is
 * still in flight). `0` for anything unreadable, which sorts it to the top
 * rather than dropping it.
 */
export function noteCreatedMs(note: BookingNoteEntry): number {
  const raw = note.createdAt;
  if (raw == null) return 0;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const ts = raw as { toDate?: () => Date };
  if (typeof ts.toDate === 'function') {
    const d = ts.toDate();
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  return 0;
}

/** Oldest first. Copies rather than sorting in place: the input is a live
 *  snapshot array owned by `useCollection`. */
export function sortNotes<T extends BookingNoteEntry>(notes: readonly T[]): T[] {
  return notes.slice().sort((a, b) => noteCreatedMs(a) - noteCreatedMs(b));
}
