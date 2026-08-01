import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Phase 12 / spec 23: server-bound deletion of a `training_documents` (Tribal
 * Intel) note. Honest caveat surfaced in the UI confirm copy and audit payload:
 * deleting the source note does NOT retroactively unmerge text the reconcile
 * pipeline has already folded into Dossier.rawSummary / Kin411.rawSummary.
 */
export const DeleteTrainingDocumentArgs = z.object({
  docId: z.string().min(1).max(200),
});

export interface DeleteTrainingDocumentResult {
  ok: true;
  docId: string;
}

export async function deleteTrainingDocumentHandler(
  req: CallableRequest<unknown>,
): Promise<DeleteTrainingDocumentResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof DeleteTrainingDocumentArgs>;
  try {
    args = DeleteTrainingDocumentArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'deleteTrainingDocument validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const docRef = db().collection('training_documents').doc(args.docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Tribal Intel entry not found.');
  }

  await docRef.delete();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.DELETE_TRAINING_DOCUMENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      docId: args.docId,
      // Honest provenance: prior reconcile merges are not undone by this delete.
      note: 'Source note deleted. Already-folded dossier/411 text is not retroactively unmerged.',
    },
  });

  logEvent({
    severity: 'info',
    function: 'deleteTrainingDocument',
    event: 'admin.trainingDocument.deleted',
    uid,
    extra: { docId: args.docId },
  });

  return { ok: true, docId: args.docId };
}

export const deleteTrainingDocument = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteTrainingDocument', deleteTrainingDocumentHandler),
);
