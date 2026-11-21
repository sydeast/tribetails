import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { STAFF_ROLE_AUNTIE } from '../lib/auntieAccess';
import { enqueueNotification } from '../notifications/dispatcher';
import { cutWhole } from '../lib/cutText';

type NoteDoc = {
  authorUid?: string;
  authorRole?: string;
  body?: string;
};

/** The slice of the create event this handler reads. Exported for the tests. */
export interface BookingNoteCreateEvent {
  params: { kinfolkId: string; batchId: string; visitId: string; noteId: string };
  data?: { data(): Record<string, unknown> | undefined };
}

/**
 * #2277: who wrote a staff note, as the office's notice names her. Every staff
 * note is stamped `authorRole: 'admin'` by `addBookingNote`, the owner's and an
 * Auntie's alike, so the role cannot say which. The writer's own staff record
 * does: her name, else "An Auntie" for an Auntie and "The office" for anyone
 * else on staff. An email is never used as a name. Exported for the tests.
 */
export function noteWriterName(staff: Record<string, unknown> | undefined): string {
  const raw = typeof staff?.['displayName'] === 'string' ? staff['displayName'].trim() : '';
  if (raw !== '' && !raw.includes('@')) return raw;
  return staff?.['staffRole'] === STAFF_ROLE_AUNTIE ? 'An Auntie' : 'The office';
}

async function readStaff(uid: string): Promise<Record<string, unknown> | undefined> {
  try {
    const snap = await db().doc(`staff/${uid}`).get();
    return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
  } catch (err) {
    // The name is wording, never a reason to drop the notice.
    logEvent({
      severity: 'warn',
      function: 'onBookingNoteCreate',
      event: 'note.writer.read.failed',
      extra: { err: (err as Error)?.message },
    });
    return undefined;
  }
}

/**
 * Watches
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes/{noteId}`.
 * Fires `kincare.note.kinfolk` when the author is a kinfolk, and
 * `kincare.note.auntie` when the author is staff (vendor-parity 2026-07-02:
 * the office hears when an Auntie writes a visit note).
 *
 * #2277: the staff note's notice names the writer (`actorName`) and is not
 * sent to her (`skipActorCopy`). It goes to the office roster only, so the
 * owner's own note reaches nobody unless another admin is on the roster.
 */
export async function onBookingNoteCreateHandler(event: BookingNoteCreateEvent): Promise<void> {
  const note = event.data?.data() as NoteDoc | undefined;
  if (!note) return;
  const role = note.authorRole ?? '';
  const key =
    role === 'kinfolk'
      ? ('kincare.note.kinfolk' as const)
      : role === 'auntie' || role === 'staff' || role === 'admin'
        ? ('kincare.note.auntie' as const)
        : null;
  if (!key) return;

  const { kinfolkId, batchId, visitId, noteId } = event.params;
  const authorUid = typeof note.authorUid === 'string' ? note.authorUid.trim() : '';
  const staffNote = key === 'kincare.note.auntie';
  const [recipientUid, writer] = await Promise.all([
    resolveKinfolkUid(kinfolkId),
    staffNote && authorUid !== '' ? readStaff(authorUid) : Promise.resolve(undefined),
  ]);

  try {
    await enqueueNotification({
      key,
      recipientUid: recipientUid ?? '',
      ...(staffNote && authorUid !== '' ? { actorUid: authorUid, skipActorCopy: true } : {}),
      data: {
        kinfolkId,
        batchId,
        // `bookingId` retained for notification-template back-compat; now the visit id.
        bookingId: visitId,
        visitId,
        noteId,
        authorUid: note.authorUid ?? null,
        ...(staffNote ? { actorName: noteWriterName(writer) } : {}),
        preview: cutWhole(note.body ?? '', 200),
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onBookingNoteCreate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, batchId, visitId, noteId, err: (err as Error)?.message },
    });
  }
}

export const onBookingNoteCreate = onDocumentCreated(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes/{noteId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBookingNoteCreate', onBookingNoteCreateHandler),
);
