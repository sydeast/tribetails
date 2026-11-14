import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { validateResponse } from '../lib/callableResponse';

/**
 * #1283: what a household told its Auntie about one visit, read back to it.
 *
 * `addBookingNote` writes a household's note to `kinCares/{id}/notes` and the
 * booking wizard's "Extra Love & Context" text to the parent envelope's
 * `notes`. Neither was ever returned to the household, so the note box cleared
 * to its placeholder and the screen looked as if nothing had been saved.
 *
 * This is the read. Its one hard rule is WHOSE notes: the `notes` subcollection
 * is a shared thread. `addBookingNote` stamps `authorRole: 'kinfolk'` for a
 * household and `'admin'` for staff (an Auntie answering through the same
 * callable), and `addInternalBookingNote` keeps the office's private thread
 * beside it. `notes` holds only the rows the household itself wrote.
 *
 * #2030: WHAT THE OFFICE SAID TO THE HOUSEHOLD comes back too, in its own list,
 * `fromBusiness`, so no client can show it under "Your notes to your Auntie".
 * Three kinds, all written knowing the household reads them:
 *  - `requestAccepted`: the note the office added when it booked the request
 *    (`manageBookingSeries` APPROVE stamps `requestAcceptNote` on the visit);
 *  - `requestDeclined`: the note it added when it turned the request down
 *    (`requestDeclineNote`, stamped by the CANCEL that declines);
 *  - `visitNote`: a staff row in the `notes` thread, which every admin client
 *    labels "Kinfolk-facing note" and writes through `addBookingNote`.
 * Each carries its date and who wrote it, by staff display name only: a name
 * that is an email address is dropped and the client says the business name.
 *
 * NEVER IN THIS RESPONSE: the internal thread (`internalNotes`, shared with
 * Aunties), the owner's `adminNotes`, the session's own `notes` text, dossier
 * and 411 text. None of them is read here. The filter is applied on the server
 * before anything is serialised, so no client has to be trusted to hide what
 * it was sent.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
});

export const BookingNoteSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    /** Epoch millis the note was written; null for a row with no readable timestamp. */
    createdAtMs: z.number().int().nullable(),
  })
  .strict();

/** #2030: one thing the office said to the household about this visit. */
export const BusinessNoteSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['requestAccepted', 'requestDeclined', 'visitNote']),
    body: z.string(),
    /** Epoch millis the note was written; null for a row with no readable timestamp. */
    createdAtMs: z.number().int().nullable(),
    /** The writer's staff display name. Null when there is none fit to show (the client names the business). */
    authorName: z.string().nullable(),
  })
  .strict();
export const Result = z
  .object({
    /**
     * The text the household typed in the booking wizard's Extra Love & Context
     * step, from the parent booking. Null when it left that blank. One note per
     * booking, so a series' visits all carry the same one.
     */
    bookingNote: z.string().nullable(),
    /** Notes the household saved on this visit, oldest first. */
    notes: z.array(BookingNoteSchema),
    /** #2030: what the office said to the household about this visit, oldest first. */
    fromBusiness: z.array(BusinessNoteSchema),
  })
  .strict();

/** Hard ceiling so a runaway thread cannot make one read unbounded. */
const MAX_NOTES = 200;

function millisOf(v: unknown): number | null {
  const ms = (v as { toMillis?: () => number } | null | undefined)?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}
/** Roles `addBookingNote` stamps on a row written by staff (`'admin'` today; the other two are older spellings). */
const STAFF_AUTHOR_ROLES = new Set(['admin', 'auntie', 'staff']);
function textOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
/**
 * Staff display names for the writers, read once per distinct writer. A name
 * that is really an email address, or blank, is not a name to show a household
 * (#2030: "never an email"), so it is left out and the client names the
 * business instead. Best effort: a failed read leaves the writer unnamed.
 */
async function staffNames(uids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (uids.length === 0) return names;
  try {
    const firestore = db();
    const snaps = await Promise.all(uids.map((u) => firestore.collection('staff').doc(u).get()));
    snaps.forEach((snap, i) => {
      const name = textOf((snap.data() as { displayName?: unknown } | undefined)?.displayName);
      if (name !== null && !name.includes('@')) names.set(uids[i]!, name);
    });
  } catch {
    // Unnamed, never an error: the note itself is what the household came for.
  }
  return names;
}

export async function getBookingNotesHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getBookingNotes validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    householdStaffFlag(req.auth, 'getBookingNotes'),
    'getBookingNotes',
  );

  const parentRef = db().doc(`families/${kinfolkId}/bookings/${args.batchId}`);
  const visitRef = parentRef.collection('kinCares').doc(args.visitId);
  const visitSnap = await visitRef.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'Visit not found.');

  const parentSnap = await parentRef.get();
  const rawBookingNote = (parentSnap.data() ?? {})['notes'];
  const bookingNote =
    typeof rawBookingNote === 'string' && rawBookingNote.trim() !== '' ? rawBookingNote.trim() : null;

  const notesSnap = await visitRef.collection('notes').orderBy('createdAt', 'asc').limit(MAX_NOTES).get();
  const rows = notesSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  const notes = rows
    // Only rows the household itself wrote.
    .filter(({ data }) => data['authorRole'] === 'kinfolk' && typeof data['body'] === 'string')
    .map(({ id, data }) => ({
      id,
      body: data['body'] as string,
      createdAtMs: millisOf(data['createdAt']),
    }));
  // #2030: the office's words to the household. A row with no role, or any
  // role but staff, is in neither list.
  type Pending = { id: string; kind: 'requestAccepted' | 'requestDeclined' | 'visitNote'; body: string; createdAtMs: number | null; authorUid: string | null };
  const pending: Pending[] = [];
  const visit = (visitSnap.data() ?? {}) as Record<string, unknown>;
  const acceptNote = textOf(visit['requestAcceptNote']);
  if (acceptNote !== null) {
    pending.push({
      id: 'request-accepted',
      kind: 'requestAccepted',
      body: acceptNote,
      createdAtMs: millisOf(visit['requestAcceptedAt']),
      authorUid: textOf(visit['requestAcceptedBy']),
    });
  }
  const declineNote = textOf(visit['requestDeclineNote']);
  if (declineNote !== null) {
    pending.push({
      id: 'request-declined',
      kind: 'requestDeclined',
      body: declineNote,
      createdAtMs: millisOf(visit['requestDeclinedAt']),
      authorUid: textOf(visit['requestDeclinedBy']),
    });
  }
  for (const { id, data } of rows) {
    if (!STAFF_AUTHOR_ROLES.has(String(data['authorRole'] ?? ''))) continue;
    const body = textOf(data['body']);
    if (body === null) continue;
    pending.push({ id, kind: 'visitNote', body, createdAtMs: millisOf(data['createdAt']), authorUid: textOf(data['authorUid']) });
  }
  pending.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  const names = await staffNames([...new Set(pending.map((p) => p.authorUid).filter((u): u is string => u !== null))]);
  // `authorUid` is resolved to a name here and never leaves the server.
  const fromBusiness = pending.map(({ authorUid, ...p }) => ({
    ...p,
    authorName: authorUid !== null ? (names.get(authorUid) ?? null) : null,
  }));

  logEvent({
    severity: 'info',
    function: 'getBookingNotes',
    event: 'portal.booking.notes.read',
    uid,
    extra: { kinfolkId, batchId: args.batchId, visitId: args.visitId, count: notes.length, fromBusiness: fromBusiness.length },
  });
  return validateResponse('getBookingNotes', Result, { bookingNote, notes, fromBusiness });
}

export const getBookingNotes = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getBookingNotes', getBookingNotesHandler),
);
