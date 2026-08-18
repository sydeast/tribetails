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

/**
 * Phase 12 / spec 23: server-bound creation of a `training_documents` (Tribal
 * Intel) note. Auntie types free notes + attaches Cloudinary files and names who
 * the note is about. The saved doc is queued with `reconcileStatus: 'pending'`
 * so the nightly Python reconcile pipeline folds it into the targeted client's
 * Dossier.rawSummary / pet Kin411.rawSummary plus the AI blurbs. Replaces the
 * old client-side write so the audit entry is bound to the mutation and admin
 * claim is enforced server-side (matches the createKinCareSession precedent).
 *
 * ── THE THREE TARGETS (issue #393) ────────────────────────────────────────
 * `targetType` used to be a two-value enum, KINFOLK | KIN, and both clients
 * labelled the KINFOLK chip "Whole household". That made one word do two jobs:
 * a note about one human client read as a note about everyone under that roof.
 * Per the operator ruling there are three targets, and the words mean what this
 * codebase already means by them everywhere else:
 *
 *   HOUSEHOLD  the whole family: every kinfolk and every kin under it.
 *              `families/{kinfolkId}`.
 *   KINFOLK    one human client. `kinfolk/{kinfolkId}`.
 *   KIN        one animal. `kin/{kinId}`, scoped to its household.
 *
 * `targetKinfolkId` is the anchor id for all three, because
 * `families/{kinfolkId}` is provisioned under the SAME id as its
 * `kinfolk/{kinfolkId}` record (see triggers/familyProvision.ts): the household
 * and its anchor kinfolk share one id, so a second `targetHouseholdId` field
 * would store the same string twice and give it two places to disagree.
 * `targetKinId` narrows to one animal and stays blank for the other two.
 *
 * READING AN OLD DOC: a `training_documents` row written before this change may
 * carry no `targetType` at all (the NDJSON migration import). The clients read
 * a blank one as HOUSEHOLD, the widest, non-fabricating answer, and the one the
 * nightly pipeline already acts on. Nothing is backfilled; an old doc gains an
 * explicit `targetType` the first time an operator saves it.
 *
 * NOTE on attachments: the reconcile LLM cannot read image bytes; attachments are
 * cited as provenance (URLs) only and never claimed to have been analyzed.
 */
export const AttachmentSchema = z.object({
  storageUrl: z.string().url(),
  cloudinaryPublicId: z.string().min(1).max(300),
  fileType: z.string().max(20),
  mimeType: z.string().max(120),
  fileName: z.string().max(300),
});

export const TrainingDocumentArgs = z
  .object({
    title: z.string().max(200).default(''),
    content: z.string().max(20000).default(''),
    notes: z.string().max(4000).default(''),
    communicationType: z.string().max(120).default('note'),
    targetType: z.enum(['HOUSEHOLD', 'KINFOLK', 'KIN']),
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

export interface CreateTrainingDocumentResult {
  ok: true;
  docId: string;
}

export async function createTrainingDocumentHandler(
  req: CallableRequest<unknown>,
): Promise<CreateTrainingDocumentResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof TrainingDocumentArgs>;
  try {
    args = TrainingDocumentArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'createTrainingDocument validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const nowIso = new Date().toISOString();
  const ref = await db().collection('training_documents').add({
    title: args.title,
    content: args.content,
    notes: args.notes,
    communicationType: args.communicationType,
    targetType: args.targetType,
    targetKinfolkId: args.targetKinfolkId,
    targetKinId: args.targetType === 'KIN' ? (args.targetKinId ?? '') : '',
    // kinfolkRef preserved for back-compat: the nightly Python reconcile
    // pipeline falls back to it (reconcile_comms.py) and pre-spec-23 rows carry
    // it as their only target field.
    kinfolkRef: args.targetKinfolkId,
    attachments: args.attachments,
    reconcileStatus: 'pending',
    reconcileNotes: '',
    reconciledAt: '',
    uploadedAt: nowIso,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CREATE_TRAINING_DOCUMENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      docId: ref.id,
      targetType: args.targetType,
      targetKinfolkId: args.targetKinfolkId,
      targetKinId: args.targetKinId ?? '',
      attachmentCount: args.attachments.length,
    },
  });

  logEvent({
    severity: 'info',
    function: 'createTrainingDocument',
    event: 'admin.trainingDocument.created',
    uid,
    extra: { docId: ref.id, targetType: args.targetType, targetKinfolkId: args.targetKinfolkId },
  });

  return { ok: true, docId: ref.id };
}

export const createTrainingDocument = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createTrainingDocument', createTrainingDocumentHandler),
);
