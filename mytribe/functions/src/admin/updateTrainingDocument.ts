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
import { AttachmentSchema } from './createTrainingDocument';

/**
 * Phase 12 / spec 23: server-bound edit of a `training_documents` (Tribal Intel)
 * note. Re-queues the doc (`reconcileStatus: 'pending'`) so the next reconcile
 * pass re-folds the updated note into the targeted Dossier / Kin411.
 */
export const UpdateTrainingDocumentArgs = z
  .object({
    docId: z.string().min(1).max(200),
    title: z.string().max(200).default(''),
    content: z.string().max(20000).default(''),
    notes: z.string().max(4000).default(''),
    communicationType: z.string().max(120).default('note'),
    targetType: z.enum(['KINFOLK', 'KIN']),
    targetKinfolkId: z.string().min(1).max(120),
    targetKinId: z.string().max(120).optional(),
    attachments: z.array(AttachmentSchema).max(25).default([]),
  })
  .refine(
    (a) => a.title.trim().length > 0 || a.content.trim().length > 0 || a.attachments.length > 0,
    { message: 'Provide a title, content, or at least one attachment' },
  )
  .refine((a) => a.targetType !== 'KIN' || (a.targetKinId != null && a.targetKinId.trim().length > 0), {
    message: 'targetKinId is required when targetType is KIN',
  });

export interface UpdateTrainingDocumentResult {
  ok: true;
  docId: string;
}

export async function updateTrainingDocumentHandler(
  req: CallableRequest<unknown>,
): Promise<UpdateTrainingDocumentResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof UpdateTrainingDocumentArgs>;
  try {
    args = UpdateTrainingDocumentArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'updateTrainingDocument validation failed', {
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

  await docRef.set(
    {
      title: args.title,
      content: args.content,
      notes: args.notes,
      communicationType: args.communicationType,
      targetType: args.targetType,
      targetKinfolkId: args.targetKinfolkId,
      targetKinId: args.targetType === 'KIN' ? (args.targetKinId ?? '') : '',
      kinfolkRef: args.targetKinfolkId,
      attachments: args.attachments,
      // Re-queue: the edited note must re-fold on the next reconcile pass.
      reconcileStatus: 'pending',
      reconcileNotes: '',
      reconciledAt: '',
      updatedBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.UPDATE_TRAINING_DOCUMENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      docId: args.docId,
      targetType: args.targetType,
      targetKinfolkId: args.targetKinfolkId,
      targetKinId: args.targetKinId ?? '',
      attachmentCount: args.attachments.length,
    },
  });

  logEvent({
    severity: 'info',
    function: 'updateTrainingDocument',
    event: 'admin.trainingDocument.updated',
    uid,
    extra: { docId: args.docId, targetType: args.targetType },
  });

  return { ok: true, docId: args.docId };
}

export const updateTrainingDocument = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('updateTrainingDocument', updateTrainingDocumentHandler),
);
