import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * #1563: sending and deleting a `generated_drafts` KinTale.
 *
 * WHAT A GENERATED DRAFT IS. Operator ruling D-2026-08-04: "generated drafts
 * are just drafts of the kintales". The generator (`web/functions/generate.js`,
 * and before it the n8n workflow the May drafts came from) writes one doc here
 * per draft. Home counts them as "KinTales to review" and the KinTales list
 * files them under Drafts.
 *
 * WHY THIS EXISTS. Until #1563 none of them could reach a household. The only
 * "send" any admin client had for one was Communicate's approve, which stamps
 * `status: 'approved'` and, for a KinTale (`visit_report`), sends nothing at
 * all. A KinTale reaches a household exactly one way: a `kin_care_reports` doc
 * with `status: 'SENT'`, which `portal/getMyKinTales.ts` lists (it filters on
 * `sentAt > ''`) and `triggers/onKinTaleCreate.ts` announces as
 * `kintale.published` (household notifications stay behind the
 * `householdNotificationsLive` gate, like every other send). So publishing a
 * draft writes that report, here, on the server, for all three admin clients.
 *
 * ONE TRANSACTION, IDEMPOTENT. The report create and the draft stamp commit
 * together, and the draft carries `publishedReportId` afterwards. A second call
 * for the same draft (a double tap, a retry after a lost reply) reads that id
 * and returns it rather than minting a second report, so a household can never
 * be sent the same tale twice from one draft.
 *
 * NO VISIT IS LINKED. A generated draft names a household, not a Kin Care
 * session, so the report carries `sessionId: ''`. The portal already treats a
 * missing session as "no visit times" (`getMyKinTales.ts` resolveVisitTimes),
 * and `listOrphanReports` keys on legacy `sentVia` markers, which `'pending'` is
 * not, so the report does not land in Needs triage.
 *
 * `sentVia: 'pending'` is the same placeholder both composers write on a send,
 * and it is deliberately NOT `'catalog'` (`lib/kinTalePublishClaim.ts`), which
 * would tell `onKinTaleCreate` the client had already announced it and suppress
 * the household's notice.
 */

/** Statuses that mean "sent as a KinTale". Written by this file only. */
export const DRAFT_STATUS_PUBLISHED = 'published';

const DraftId = z.string().trim().min(1).max(200).regex(/^[^/]+$/, 'draftId must be a bare document id');

const PublishArgs = z.object({
  draftId: DraftId,
  /** The operator's final text, edits included. */
  bodyCopy: z.string().max(20000),
  /** The headline as the operator left it. Blank means the draft's own title, if it has one. */
  title: z.string().max(500).optional(),
});

const DeleteArgs = z.object({ draftId: DraftId });

export interface PublishGeneratedDraftResult {
  ok: true;
  reportId: string;
  /** True when this draft had already been published and nothing new was written. */
  alreadyPublished: boolean;
}

export interface DeleteGeneratedDraftResult {
  ok: true;
  draftId: string;
}

/** First non-blank string of the two spellings this collection is written in. */
function either(a: unknown, b: unknown): string {
  const first = typeof a === 'string' ? a.trim() : '';
  if (first !== '') return first;
  return typeof b === 'string' ? b.trim() : '';
}

function displayNameOf(kinfolk: Record<string, unknown> | undefined): string {
  const first = typeof kinfolk?.['firstName'] === 'string' ? (kinfolk['firstName'] as string).trim() : '';
  const last = typeof kinfolk?.['lastName'] === 'string' ? (kinfolk['lastName'] as string).trim() : '';
  return [first, last].filter(Boolean).join(' ');
}

export async function publishGeneratedDraftHandler(
  req: CallableRequest<unknown>,
): Promise<PublishGeneratedDraftResult> {
  const actorUid = req.auth?.uid ?? '';
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const parsed = PublishArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }
  const args = parsed.data;
  const body = args.bodyCopy.trim();
  if (body === '') {
    throw new HttpsError('invalid-argument', 'The KinTale is empty. Write something before sending it.');
  }

  const token = (req.auth?.token ?? {}) as Record<string, unknown>;
  const authorDisplayName = (typeof token['name'] === 'string' ? token['name'].trim() : '') || 'Auntie';
  const draftRef = db().collection('generated_drafts').doc(args.draftId);
  const reportRef = db().collection('kin_care_reports').doc();
  const now = new Date().toISOString();

  const outcome = await db().runTransaction(async (tx) => {
    const draftSnap = await tx.get(draftRef);
    if (!draftSnap.exists) {
      throw new HttpsError('not-found', 'This draft no longer exists. It may have been deleted.');
    }
    const draft = (draftSnap.data() ?? {}) as Record<string, unknown>;

    const already = typeof draft['publishedReportId'] === 'string' ? draft['publishedReportId'].trim() : '';
    if (already !== '') {
      return { reportId: already, alreadyPublished: true, kinfolkId: either(draft['kinfolk_id'], draft['kinfolkId']) };
    }

    const kinfolkId = either(draft['kinfolk_id'], draft['kinfolkId']);
    if (kinfolkId === '') {
      throw new HttpsError(
        'failed-precondition',
        'This draft is not addressed to a household, so there is nobody to send it to.',
      );
    }
    const kinfolkSnap = await tx.get(db().collection('kinfolk').doc(kinfolkId));
    if (!kinfolkSnap.exists) {
      throw new HttpsError('failed-precondition', 'The household this draft is addressed to no longer exists.');
    }
    const kinfolkName =
      displayNameOf(kinfolkSnap.data() as Record<string, unknown> | undefined) ||
      either(draft['kinfolkName'], draft['kinfolk_name']);

    const draftTitle = either(draft['generatedTitle'], draft['generated_title']);
    const typedTitle = (args.title ?? '').trim();
    const title = typedTitle !== '' ? typedTitle : draftTitle;

    tx.set(reportRef, {
      kinfolkId,
      kinfolkName,
      kinIds: [],
      sessionId: '',
      serviceType: '',
      visitDate: '',
      arrivedAt: '',
      title,
      titleGeneratedByAi: title !== '' && title === draftTitle,
      bodyCopy: body,
      mediaFileIds: [],
      templateId: '',
      fieldResponses: {},
      status: 'SENT',
      sentAt: now,
      sentVia: 'pending',
      deliveryReceiptId: '',
      authorId: actorUid,
      authorDisplayName,
      sourceDraftId: args.draftId,
      createdAt: now,
      updatedAt: now,
    });
    tx.update(draftRef, {
      status: DRAFT_STATUS_PUBLISHED,
      generatedCopy: body,
      publishedReportId: reportRef.id,
      publishedAt: now,
      approvedAt: now,
      approvedBy: actorUid,
    });
    return { reportId: reportRef.id, alreadyPublished: false, kinfolkId };
  });

  if (!outcome.alreadyPublished) {
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.KINTALE_DRAFT_PUBLISHED,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid,
      targetUid: outcome.reportId,
      targetCollection: 'kin_care_reports',
      // #1747: the Activity Log shows this text as written, so it is words. The
      // draft, the KinTale and the household stay on the entry as its target
      // and payload, which is where the evidence log keeps ids.
      description: 'Sent a KinTale draft',
      payload: { draftId: args.draftId, reportId: outcome.reportId, kinfolkId: outcome.kinfolkId },
    });
  }
  logEvent({
    severity: 'info',
    function: 'publishGeneratedDraft',
    event: outcome.alreadyPublished ? 'kintale.draft.publish.replayed' : 'kintale.draft.published',
    uid: actorUid,
    extra: { draftId: args.draftId, reportId: outcome.reportId },
  });
  return { ok: true, reportId: outcome.reportId, alreadyPublished: outcome.alreadyPublished };
}

export async function deleteGeneratedDraftHandler(
  req: CallableRequest<unknown>,
): Promise<DeleteGeneratedDraftResult> {
  const actorUid = req.auth?.uid ?? '';
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const parsed = DeleteArgs.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }
  const { draftId } = parsed.data;
  const draftRef = db().collection('generated_drafts').doc(draftId);

  const kinfolkId = await db().runTransaction(async (tx) => {
    const snap = await tx.get(draftRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'This draft no longer exists. It may already have been deleted.');
    }
    const draft = (snap.data() ?? {}) as Record<string, unknown>;
    // A published draft is the record of a KinTale a household has. The tale
    // itself lives on in kin_care_reports either way, but the draft is what
    // says where it came from, so it stays.
    const published = typeof draft['publishedReportId'] === 'string' ? draft['publishedReportId'].trim() : '';
    if (published !== '') {
      throw new HttpsError('failed-precondition', 'This draft has already been sent as a KinTale, so it is kept.');
    }
    tx.delete(draftRef);
    return either(draft['kinfolk_id'], draft['kinfolkId']);
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.KINTALE_DRAFT_DELETED,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid,
    targetUid: draftId,
    targetCollection: 'generated_drafts',
    description: 'Deleted a KinTale draft',
    payload: { draftId, kinfolkId: kinfolkId || null },
  });
  logEvent({
    severity: 'warn',
    function: 'deleteGeneratedDraft',
    event: 'kintale.draft.deleted',
    uid: actorUid,
    extra: { draftId },
  });
  return { ok: true, draftId };
}

export const publishGeneratedDraft = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('publishGeneratedDraft', publishGeneratedDraftHandler),
);

export const deleteGeneratedDraft = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteGeneratedDraft', deleteGeneratedDraftHandler),
);
