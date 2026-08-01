import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { CriteriaSchema, describeCriteria } from './audienceCriteria';

/**
 * Stage 2 step 6 (Communicate broadcast) - saved audience segments.
 *
 * A segment is a named, reusable kinfolk filter stored in `audience_segments`.
 * The admin builds one in AuntieOS, then picks it when composing a broadcast.
 * All access is admin-gated and goes through callables (no direct client write)
 * so every save/delete is validated + audited and the collection stays
 * server-authored. Reads also go through `listAudienceSegments` so a test-admin
 * (who is not isAuntie) can never enumerate the operator's segments.
 */

export const SEGMENTS_COLLECTION = 'audience_segments';

const SaveArgs = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(120),
  criteria: CriteriaSchema,
});

export interface SegmentRecord {
  id: string;
  name: string;
  criteria: z.infer<typeof CriteriaSchema>;
  description: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export async function saveAudienceSegmentHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; id: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof SaveArgs>;
  try {
    args = SaveArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'saveAudienceSegment validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const now = Date.now();
  const description = describeCriteria(args.criteria);
  const ref = args.id
    ? db().collection(SEGMENTS_COLLECTION).doc(args.id)
    : db().collection(SEGMENTS_COLLECTION).doc();

  const isUpdate = !!args.id;
  await ref.set(
    {
      name: args.name.trim(),
      criteria: args.criteria,
      description,
      actorUid: uid,
      updatedAtMs: now,
      ...(isUpdate ? {} : { createdAtMs: now, createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUDIENCE_SEGMENT_SAVED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SEGMENTS_COLLECTION,
    description: `Audience segment ${isUpdate ? 'updated' : 'created'}: ${args.name.trim()} (${description})`,
    payload: { segmentId: ref.id, name: args.name.trim(), criteria: args.criteria },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'saveAudienceSegment',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, id: ref.id };
}

export const saveAudienceSegment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveAudienceSegment', saveAudienceSegmentHandler),
);

// ---------------------------------------------------------------------------
// listAudienceSegments: admin-only list of saved segments, newest first.
// ---------------------------------------------------------------------------

export async function listAudienceSegmentsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; segments: SegmentRecord[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection(SEGMENTS_COLLECTION).get();
  const segments: SegmentRecord[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: typeof data.name === 'string' ? data.name : '',
      // criteria is stored verbatim; cast through unknown (the save path validated it).
      criteria: data.criteria as SegmentRecord['criteria'],
      description: typeof data.description === 'string' ? data.description : '',
      createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : 0,
      updatedAtMs: typeof data.updatedAtMs === 'number' ? data.updatedAtMs : 0,
    };
  });
  // Newest-updated first (sorted in memory; the collection is admin-small).
  segments.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return { ok: true, segments };
}

export const listAudienceSegments = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listAudienceSegments', listAudienceSegmentsHandler),
);

// ---------------------------------------------------------------------------
// deleteAudienceSegment: admin removes a saved segment.
// ---------------------------------------------------------------------------

const DeleteArgs = z.object({ id: z.string().min(1).max(200) });

export async function deleteAudienceSegmentHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; id: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof DeleteArgs>;
  try {
    args = DeleteArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'deleteAudienceSegment validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection(SEGMENTS_COLLECTION).doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Audience segment ${args.id} does not exist.`);
  }
  const name = (snap.data()?.name as string | undefined) ?? args.id;
  await ref.delete();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUDIENCE_SEGMENT_DELETED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SEGMENTS_COLLECTION,
    description: `Audience segment deleted: ${name}`,
    payload: { segmentId: args.id, name },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'deleteAudienceSegment',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, id: args.id };
}

export const deleteAudienceSegment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteAudienceSegment', deleteAudienceSegmentHandler),
);
