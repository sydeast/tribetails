import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { toPlainTextPreview } from '../lib/richText';
import { anthropicClient, AI_MODEL, BRAND_VOICE_SYSTEM } from '../lib/aiCopy';

/**
 * O-8 bulk job: backfill titles on sent kin tales that never got one.
 *
 * Staff-gated. Uses the Anthropic Batch API (50% of interactive price) per the
 * plan doc's AI decisions: this callable SCANS for untitled tales and CREATES
 * the batch; `aiBatchPollCron` (src/scheduled/aiBatchPollCron.ts) collects the
 * finished batch and writes the titles. Nothing is written to tales here.
 *
 * Tale source of truth: `kin_care_reports` (flat; AuntieOS owns writes). We
 * only ever fill an EMPTY title, and stamp `titleGeneratedByAi` so AuntieOS
 * and humans can tell generated titles apart from auntie-authored ones.
 */

export const AI_BATCHES_COLLECTION = 'ai_batches';
export const TALES_COLLECTION = 'kin_care_reports';
/** Page size for the paginated scan (in-memory title filter follows). */
const SCAN_PAGE = 300;
/** Absolute per-invocation scan ceiling across all pages. */
const SCAN_MAX_TOTAL = 3000;
/** Cap per created batch; rerun the callable for more. */
const BATCH_CAP = 100;
/** How much of the tale body the title prompt sees. */
const BODY_PREVIEW_CHARS = 2000;

const Args = z.object({
  /** Dry run: report the candidate count without creating a batch. */
  dryRun: z.boolean().optional(),
});

export const TITLE_INSTRUCTION =
  'Task: write a title for the pet-visit tale below. 2 to 6 words, plain text, no quotes, ' +
  'no ending punctuation. Concrete and warm, drawn only from what the tale says.\n\nTale:';

interface Candidate {
  id: string;
  body: string;
}

function isUntitled(data: Record<string, unknown>): boolean {
  const title = data['title'];
  return title === undefined || title === null || (typeof title === 'string' && title.trim().length === 0);
}

export async function aiBackfillTaleTitlesHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; candidates: number; batched: number; batchId: string | null; alreadyProcessing?: boolean }> {
  initSentry();
  const uid = req.auth?.uid as string; // wrapAdminCallable already enforced staff

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'aiBackfillTaleTitles validation failed');
    }
    throw err;
  }

  // One in-flight tale-title batch at a time: candidates aren't marked until
  // the poll cron applies results, so a double-submit (or a second staff
  // member) would otherwise pay for the same tales twice (review finding 2).
  const inFlight = await db()
    .collection(AI_BATCHES_COLLECTION)
    .where('type', '==', 'tale_titles')
    .where('status', '==', 'processing')
    .limit(1)
    .get();
  if (inFlight.docs.length > 0 && !args.dryRun) {
    return { ok: true, candidates: 0, batched: 0, batchId: inFlight.docs[0].id, alreadyProcessing: true };
  }

  // Sent tales only (same DRAFT exclusion as getMyKinTales). `title == ''`
  // can't be queried together with missing-field docs, so scan pages and
  // filter in memory. Paginated so reruns can reach the legacy backlog
  // beyond the newest page (review finding 3), bounded by SCAN_MAX_TOTAL.
  const candidates: Candidate[] = [];
  let scanned = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  while (candidates.length < BATCH_CAP && scanned < SCAN_MAX_TOTAL) {
    let q = db()
      .collection(TALES_COLLECTION)
      .where('sentAt', '>', '')
      .orderBy('sentAt', 'desc')
      .limit(SCAN_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.docs.length === 0) break;
    scanned += snap.docs.length;
    cursor = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      // Real writer field is `bodyCopy` (AuntieOS; see getMyKinTales mapping) —
      // NOT `body`, which only exists on the portal DTO.
      const body = typeof data['bodyCopy'] === 'string' ? data['bodyCopy'] : '';
      if (isUntitled(data) && body.trim().length > 0) {
        candidates.push({ id: doc.id, body });
        if (candidates.length >= BATCH_CAP) break;
      }
    }
    // Short page = end of collection.
    if (snap.docs.length < SCAN_PAGE) break;
  }

  if (args.dryRun || candidates.length === 0) {
    return { ok: true, candidates: candidates.length, batched: 0, batchId: null };
  }

  const client = anthropicClient();
  const batch = await client.messages.batches.create({
    requests: candidates.map((tale) => ({
      custom_id: tale.id,
      params: {
        model: AI_MODEL,
        max_tokens: 64,
        system: [{ type: 'text' as const, text: BRAND_VOICE_SYSTEM }],
        messages: [
          {
            role: 'user' as const,
            content: `${TITLE_INSTRUCTION}\n\n${toPlainTextPreview(tale.body, BODY_PREVIEW_CHARS)}`,
          },
        ],
      },
    })),
  });

  await db().collection(AI_BATCHES_COLLECTION).doc(batch.id).set({
    type: 'tale_titles',
    status: 'processing',
    createdAtMs: Date.now(),
    requestedBy: uid,
    requestCount: candidates.length,
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.AI_TALE_TITLES_BATCH_CREATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: TALES_COLLECTION,
    description: `AI tale-title backfill batch created (${candidates.length} tales)`,
    payload: { batchId: batch.id, requestCount: candidates.length },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'aiBackfillTaleTitles',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, candidates: candidates.length, batched: candidates.length, batchId: batch.id };
}

export const aiBackfillTaleTitles = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS', 'ANTHROPIC_API_KEY'],
    timeoutSeconds: 120,
  },
  wrapAdminCallable('aiBackfillTaleTitles', aiBackfillTaleTitlesHandler),
);
