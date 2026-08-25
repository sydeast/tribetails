import { call } from '../lib/fns';
import { requestSignedUpload, resourceKindForFile, uploadToCloudinary, writeMediaFileDoc } from './mediaUpload';
import type { TribalIntelAttachmentDraft, TribalIntelCallableArgs } from '../lib/tribalIntelDraftSchema';

/**
 * The write half of the Tribal Intel surface (`api/tribalIntel.ts` stays
 * read-only, the `account.ts` / `accountWrite.ts` split).
 *
 * EVERY WRITE GOES THROUGH A CALLABLE, not by preference but by rule:
 * `MyTribe/firestore.rules` has `match /training_documents/{id} { allow read:
 * if isAuntie(); allow write: if false; }`, so a direct client `addDoc` here
 * would be denied. The three callables already exist and are deployed:
 *   `functions/src/admin/createTrainingDocument.ts`  -> { ok, docId }
 *   `functions/src/admin/updateTrainingDocument.ts`  -> { ok, docId }
 *   `functions/src/admin/deleteTrainingDocument.ts`  -> { ok, docId }
 * All three are `wrapAdminCallable`-gated and parse their args with zod, whose
 * rules `lib/tribalIntelDraftSchema.ts` mirrors so the operator sees a failure
 * before the round trip rather than a raw "validation failed" after it.
 *
 * Arg shape is FLAT (title, content, notes, ... at the top level), not wrapped
 * in an envelope: confirmed against each handler's `TrainingDocumentArgs.parse(
 * req.data)`. Update is the same shape plus `docId`; delete takes `{ docId }`
 * alone.
 */

export type TribalIntelWriteArgs = TribalIntelCallableArgs;

interface TrainingDocumentResult {
  ok: true;
  docId: string;
}

/**
 * Creates one `training_documents` entry. Returns the server-assigned doc id.
 *
 * The saved entry lands with `reconcileStatus: 'pending'`: the nightly reconcile
 * pipeline is what folds it into the household dossier and the pet 411, so
 * callers must confirm with `TRIBAL_INTEL_QUEUED_MESSAGE` and never imply the
 * fold already happened.
 */
export async function createTrainingDocument(args: TribalIntelWriteArgs): Promise<string> {
  const res = await call<TribalIntelWriteArgs, TrainingDocumentResult>('createTrainingDocument', args);
  return res.docId;
}

/**
 * Edits one entry in place and re-queues it (`reconcileStatus: 'pending'`), so
 * the next pass re-folds the corrected text. `uploadedAt` is NOT re-stamped
 * server-side, so an edited row keeps its place in the list rather than jumping
 * to the top.
 */
export async function updateTrainingDocument(docId: string, args: TribalIntelWriteArgs): Promise<string> {
  const id = docId.trim();
  if (id === '') throw new Error('updateTrainingDocument requires a docId');
  const res = await call<{ docId: string } & TribalIntelWriteArgs, TrainingDocumentResult>(
    'updateTrainingDocument',
    { docId: id, ...args },
  );
  return res.docId;
}

/**
 * Hard-deletes one entry. The server handler documents, and its audit payload
 * records, that this does NOT unmerge text a prior reconcile pass already
 * folded into a dossier or 411; callers must show
 * `TRIBAL_INTEL_DELETE_CAVEAT` before confirming.
 */
export async function deleteTrainingDocument(docId: string): Promise<void> {
  const id = docId.trim();
  if (id === '') throw new Error('deleteTrainingDocument requires a docId');
  await call<{ docId: string }, TrainingDocumentResult>('deleteTrainingDocument', { docId: id });
}

// ── attachments ─────────────────────────────────────────────────────────────

/**
 * The entityId every Tribal Intel attachment is uploaded under.
 *
 * Attachments are picked BEFORE the entry exists (there is no doc id yet on a
 * create), so the media pipeline needs a stable placeholder. `"pending"` is
 * Android's own choice for the identical flow
 * (`AdminDataViewModel#uploadTribalIntelAttachment`), kept verbatim so both
 * clients file into the same Cloudinary folder rather than two.
 */
export const TRIBAL_INTEL_UPLOAD_ENTITY_ID = 'pending';

/**
 * Uploads one picked file and returns the attachment record the create/update
 * callable expects.
 *
 * Runs the same three-step pipeline as the Gallery dialog (sign, upload to
 * Cloudinary, write the `media_files` doc), so a Tribal Intel attachment is a
 * first-class media file rather than a URL that exists nowhere else. Fail-loud
 * throughout: any step throwing propagates, and no half-built attachment is
 * ever returned.
 *
 * `fileType` is derived from Cloudinary's own `resource_type`, the same
 * IMAGE/VIDEO mapping `writeMediaFileDoc` uses, so the stored attachment and
 * the stored media file can never disagree about what was uploaded.
 *
 * NOTE the reconcile pipeline treats attachments as PROVENANCE ONLY. The
 * summarizer cites the URL; it does not read image bytes. The form says so.
 */
export async function uploadTribalIntelAttachment(file: File): Promise<TribalIntelAttachmentDraft> {
  // #583: attachments run the same pipeline, so a photographed document
  // attached here is stripped exactly like a gallery photo. The kind comes from
  // the file itself, so a video or a PDF is not signed with an image-only
  // transformation.
  const sign = await requestSignedUpload('TRIBAL_INTEL', TRIBAL_INTEL_UPLOAD_ENTITY_ID, resourceKindForFile(file));
  const cloud = await uploadToCloudinary(file, sign);

  await writeMediaFileDoc({
    entityId: TRIBAL_INTEL_UPLOAD_ENTITY_ID,
    entityType: 'TRIBAL_INTEL',
    originalFileName: file.name,
    cloud,
    cloudName: sign.cloudName,
  });

  const isVideo = cloud.resourceType.trim().toLowerCase() === 'video';
  return {
    storageUrl: cloud.secureUrl,
    cloudinaryPublicId: cloud.publicId,
    fileType: isVideo ? 'VIDEO' : 'IMAGE',
    mimeType: file.type,
    fileName: file.name,
  };
}
