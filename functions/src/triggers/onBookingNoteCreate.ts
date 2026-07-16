import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type NoteDoc = {
  authorUid?: string;
  authorRole?: string;
  body?: string;
};

/**
 * Watches
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes/{noteId}`.
 * Fires `kincare.note.kinfolk` when the author is a kinfolk, and
 * `kincare.note.auntie` when the author is staff (vendor-parity 2026-07-02:
 * the office hears when an Auntie writes a visit note).
 */
export const onBookingNoteCreate = onDocumentCreated(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/notes/{noteId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBookingNoteCreate', async (event) => {
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

    const kinfolkId = event.params.kinfolkId as string;
    const batchId = event.params.batchId as string;
    const visitId = event.params.visitId as string;
    const noteId = event.params.noteId as string;
    const recipientUid = await resolveKinfolkUid(kinfolkId);

    try {
      await enqueueNotification({
        key,
        recipientUid: recipientUid ?? '',
        data: {
          kinfolkId,
          batchId,
          // `bookingId` retained for notification-template back-compat; now the visit id.
          bookingId: visitId,
          visitId,
          noteId,
          authorUid: note.authorUid ?? null,
          preview: (note.body ?? '').slice(0, 200),
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
  }),
);
