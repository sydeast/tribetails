import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { isAuntieClaim } from '../lib/staffGate';
import {
  ADMIN_ONLY_NOTES,
  SHARED_NOTES,
  VISIT_NOTE_KINDS,
  createdAtMsOf,
  resolveVisitNoteTarget,
} from '../lib/visitNotes';

/**
 * #1580: the one list of internal notes on a visit, as the CALLER may see it.
 *
 * Every admin surface (Bookings, Schedule, Auntie Time; web, Android and the
 * desktop console) reads a visit's internal notes through this, so all of them
 * show the same list under the same label. Before #1580 there were two stores:
 * the booking record's `internalNotes` thread (Bookings) and the session's
 * `notes` text (Auntie Time), and each screen showed only its own.
 *
 * WHY A CALLABLE AND NOT A CLIENT LISTENER. The admin-only kind lives in its own
 * collection that rules let only the owner read (see `lib/visitNotes.ts`). A
 * client listening to it as an Auntie gets permission-denied, which no client
 * can tell apart from a real failure, and neither Android nor the desktop
 * console reads the caretaker claim at all. Filtering here, on the caller's
 * claim, puts the ruling in one place: an Auntie's response simply never
 * contains an admin-only note, and `canMarkAdminOnly` tells the composer whether
 * to offer the mark.
 *
 * Operator ruling, 2026-11-05 docket: "two kinds, shared and admin-only. The
 * writer marks each note. Aunties see only shared notes."
 */
export const Args = z
  .object({
    sessionId: z.string().min(1).max(200).optional(),
    kinfolkId: z.string().min(1).optional(),
    batchId: z.string().min(1).optional(),
    visitId: z.string().min(1).optional(),
  })
  .refine((a) => a.sessionId || (a.kinfolkId && a.batchId && a.visitId), {
    message: 'Provide sessionId, or kinfolkId with batchId+visitId.',
  });

const NoteSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    /** 'admin' (the owner) or 'auntie'; 'unknown' for a row that carries neither. */
    authorRole: z.enum(['admin', 'auntie', 'unknown']),
    /** The writer's staff display name, when one is on file. */
    authorName: z.string().nullable(),
    createdAtMs: z.number().nullable(),
    visibility: z.enum(VISIT_NOTE_KINDS),
    /** 'thread' for a note in the booking record; 'visitRecord' for the session's older notes text. */
    source: z.enum(['thread', 'visitRecord']),
  })
  .strict();

export const Result = z
  .object({
    notes: z.array(NoteSchema),
    /** True for the owner: the composer may offer "Admin only". */
    canMarkAdminOnly: z.boolean(),
    /** False for an older visit with no booking record; its notes live in the session text only. */
    hasBookingRecord: z.boolean(),
  })
  .strict();

export type VisitInternalNote = z.infer<typeof NoteSchema>;

/** How many notes one kind returns. A visit's thread is a handful of lines. */
const NOTES_MAX = 200;

function authorRoleOf(raw: unknown): 'admin' | 'auntie' | 'unknown' {
  return raw === 'admin' || raw === 'auntie' ? raw : 'unknown';
}

export async function listVisitInternalNotesHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const args = Args.parse(req.data);
  const canMarkAdminOnly = !isAuntieClaim(req.auth?.token);
  const target = await resolveVisitNoteTarget(args);

  type Row = Omit<VisitInternalNote, 'authorName'> & { authorUid: string | null };
  const rows: Row[] = [];
  if (target.sessionNotes !== '') {
    rows.push({
      id: `session:${target.sessionRef?.id ?? 'visit'}`,
      body: target.sessionNotes,
      authorRole: 'unknown',
      authorUid: null,
      createdAtMs: null,
      visibility: 'shared',
      source: 'visitRecord',
    });
  }

  if (target.visitRef !== null) {
    const kinds: Array<[string, 'shared' | 'adminOnly']> = [[SHARED_NOTES, 'shared']];
    // The ruling, enforced: an Auntie's response never reads the admin-only
    // collection, so nothing in it can reach her.
    if (canMarkAdminOnly) kinds.push([ADMIN_ONLY_NOTES, 'adminOnly']);
    const snaps = await Promise.all(kinds.map(([sub]) => target.visitRef!.collection(sub).limit(NOTES_MAX).get()));
    snaps.forEach((snap, i) => {
      const visibility = kinds[i][1];
      for (const d of snap.docs) {
        const data = (d.data() ?? {}) as Record<string, unknown>;
        rows.push({
          id: d.id,
          body: typeof data['body'] === 'string' ? data['body'] : '',
          authorRole: authorRoleOf(data['authorRole']),
          authorUid: typeof data['authorUid'] === 'string' ? data['authorUid'] : null,
          createdAtMs: createdAtMsOf(data['createdAt']) ?? createdAtMsOf(data['createdAtMs']),
          visibility,
          source: 'thread',
        });
      }
    });
  }

  // The session text has no date of its own, so it reads first, as the oldest.
  rows.sort((a, b) => (a.createdAtMs ?? -1) - (b.createdAtMs ?? -1));

  const uids = [...new Set(rows.map((r) => r.authorUid).filter((u): u is string => u !== null))];
  const names = new Map<string, string>();
  await Promise.all(
    uids.map(async (uid) => {
      const snap = await db().collection('staff').doc(uid).get();
      const name = (snap.data() as { displayName?: unknown } | undefined)?.displayName;
      if (typeof name === 'string' && name.trim() !== '') names.set(uid, name.trim());
    }),
  );

  const notes = rows.map(({ authorUid, ...r }) => ({
    ...r,
    authorName: authorUid !== null ? (names.get(authorUid) ?? null) : null,
  }));
  return validateResponse('listVisitInternalNotes', Result, {
    notes,
    canMarkAdminOnly,
    hasBookingRecord: target.visitRef !== null,
  });
}

export const listVisitInternalNotes = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listVisitInternalNotes', listVisitInternalNotesHandler),
);
