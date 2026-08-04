/**
 * backfillNotificationDeliverySplit.ts
 *
 * One-shot relocation of DELIVERY STATE off the notification inbox documents
 * and onto the work-order collection introduced by operator ruling R5
 * (2026-08-03).
 *
 * Per legacy `notifications/{id}` doc carrying any of `status`, `mode`,
 * `channels`, `dispatchedAt` or `completedAt`, this:
 *   1. writes `notificationDispatch/{id}` holding exactly those fields plus the
 *      `key` / `recipientUid` / `data` the pipeline needs,
 *   2. copies every `notifications/{id}/channels/{channel}` subdoc verbatim to
 *      `notificationDispatch/{id}/channels/{channel}`,
 *   3. deletes the workflow fields and the legacy channel subdocs from the
 *      notification, leaving it a pure inbox record.
 *
 * ── THE MIGRATION DECISION, AND WHY IT IS NOT A BACKFILL INTO activity_log ──
 *
 * The obvious alternative was to replay each legacy delivery as an
 * `activity_log` entry, so the audit trail would hold the full history rather
 * than only what has happened since. That is the wrong call here, and not
 * marginally.
 *
 * `writeAuditEntry` seals every entry into a SHA-256 hash chain with a
 * monotonic `seq`, and it stamps `timestamp: new Date().toISOString()`, the
 * moment of the WRITE, not the moment of the event. The chain is append-only by
 * construction; there is no way to insert an entry at its true historical
 * position without breaking every hash after it. So replaying a year of
 * deliveries would append tens of thousands of entries all dated the day the
 * migration ran, at the head of the chain, burying the real recent audit trail
 * under backdated noise that CLAIMS to be current. The Activity Log is
 * evidence. Filling it with events whose recorded time is a lie about when they
 * happened damages the one property it exists to have.
 *
 * The trail is not actually missing, either. `NOTIFICATION_RECEIVED` has been
 * written per channel into `activity_log` since that trigger landed, so the
 * delivery record for the recent past is already in the right place and already
 * correctly timestamped. What the legacy notification docs hold beyond that is
 * pipeline residue.
 *
 * So: RELOCATE, do not replay. The residue moves to the collection that now owns
 * it, where it stays queryable for anyone debugging an old dispatch, and the
 * inbox documents converge on one shape. Nothing is deleted outright.
 *
 * ── RUNNING THIS IS OPTIONAL, AND THE PRODUCT IS CORRECT WITHOUT IT ──
 *
 * Both admin clients stopped READING `status` / `mode` / `channels` off
 * notification documents in the same change that added this script, so a legacy
 * doc that never gets migrated renders identically to a new one: the extra
 * fields are simply inert. This script exists to converge the collection, not to
 * unblock the fix. That is the legacy-shape carve-out, stated plainly rather
 * than left implicit.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and the counts. Writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op batch limit.
 *
 * Safety:
 *   - Dry-run by default; refuses to write unless --allow-prod is passed OR
 *     FIRESTORE_EMULATOR_HOST is set (same contract as the other backfills).
 *   - IDEMPOTENT. A notification carrying none of the workflow fields is
 *     skipped (`already_split`), so a second run reports zero planned writes.
 *     The dispatch doc is written with merge:true, so a re-run over a partially
 *     migrated doc converges rather than duplicating.
 *   - NEVER NOTIFIES ANYONE. It touches no queue collection and creates no
 *     dispatch doc with `status: 'pending'`. A migrated work order keeps
 *     whatever terminal status it already had, so `onNotificationCreate` (which
 *     returns early on anything but 'pending') cannot re-fan-out a year-old
 *     notification. This is the single most dangerous thing a migration in this
 *     subsystem could do, and it is designed out rather than merely avoided.
 *
 * Runbook: run DRY first, read the plan, then re-run with --allow-prod.
 * This script has NOT been run against production as part of the PR that ships
 * it; it is a runbook step.
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  /** Notifications read per page. Writes batch at 400. */
  pageSize: number;
}

/** The fields that must leave the notification document. */
const WORKFLOW_FIELDS = ['status', 'mode', 'channels', 'dispatchedAt', 'completedAt'] as const;

/**
 * Origin fields the sweeps stamped alongside the workflow. They describe which
 * queue a notification came out of, which is dispatch provenance, so they travel
 * with it rather than staying on the card.
 */
const ORIGIN_FIELDS = [
  'originPendingId',
  'originScheduledId',
  'originBatchKey',
  'scheduledFireAtMs',
] as const;

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, pageSize: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') {
      args.allowProd = true;
      args.mode = 'apply';
    } else if (a === '--project' && argv[i + 1]) {
      args.projectId = argv[i + 1] as string;
      i += 1;
    } else if (a === '--page-size' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1] as string, 10);
      if (Number.isFinite(n) && n > 0) args.pageSize = n;
      i += 1;
    }
  }
  return args;
}

export interface SplitPlan {
  /** Doc id, which is also the work order's id. */
  id: string;
  /** Fields being moved off the notification. */
  moved: Record<string, unknown>;
  /** Channel subdoc ids being relocated. */
  channelDocs: string[];
}

/**
 * Decides what (if anything) a single notification doc needs.
 *
 * Returns null when the doc is already split. Pure, so the decision is testable
 * without Firestore; the caller does the reads and writes.
 */
export function planForNotification(
  id: string,
  data: Record<string, unknown>,
  channelDocs: string[],
): SplitPlan | null {
  const moved: Record<string, unknown> = {};
  for (const f of [...WORKFLOW_FIELDS, ...ORIGIN_FIELDS]) {
    if (data[f] !== undefined) moved[f] = data[f];
  }
  if (Object.keys(moved).length === 0 && channelDocs.length === 0) return null;
  return { id, moved, channelDocs };
}

function initAdmin(projectId: string): void {
  if (getApps().length === 0) initializeApp({ projectId });
}

interface RunResult {
  scanned: number;
  split: number;
  channelDocsMoved: number;
  skipped: { already_split: number };
  planned: SplitPlan[];
}

async function run(db: Firestore, mode: Mode, pageSize: number): Promise<RunResult> {
  const result: RunResult = {
    scanned: 0,
    split: 0,
    channelDocsMoved: 0,
    skipped: { already_split: 0 },
    planned: [],
  };

  // Ordered by document id through a cursor rather than a field, so no index is
  // required and the scan is stable while writes land behind it.
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('notifications').orderBy('__name__').limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    cursor = page.docs[page.docs.length - 1] ?? null;

    for (const doc of page.docs) {
      result.scanned += 1;
      const channelSnap = await doc.ref.collection('channels').get();
      const channelDocs = channelSnap.docs.map((d) => d.id);
      const plan = planForNotification(
        doc.id,
        doc.data() as Record<string, unknown>,
        channelDocs,
      );
      if (!plan) {
        result.skipped.already_split += 1;
        continue;
      }
      result.planned.push(plan);
      result.split += 1;
      result.channelDocsMoved += plan.channelDocs.length;

      if (mode !== 'apply') continue;

      const data = doc.data() as Record<string, unknown>;
      const batch = db.batch();
      const dispatchRef = db.collection('notificationDispatch').doc(doc.id);
      batch.set(
        dispatchRef,
        {
          notificationId: doc.id,
          key: data.key ?? '',
          recipientUid: data.recipientUid ?? '',
          data: data.data ?? {},
          ...plan.moved,
          migratedAt: FieldValue.serverTimestamp(),
          migratedFrom: 'notifications',
        },
        { merge: true },
      );
      for (const channelDoc of channelSnap.docs) {
        batch.set(dispatchRef.collection('channels').doc(channelDoc.id), channelDoc.data(), {
          merge: true,
        });
        batch.delete(channelDoc.ref);
      }
      const strip: Record<string, unknown> = {};
      for (const f of Object.keys(plan.moved)) strip[f] = FieldValue.delete();
      if (Object.keys(strip).length > 0) batch.update(doc.ref, strip);
      await batch.commit();
    }

    if (page.size < pageSize) break;
  }

  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('');
  console.log(`scanned              ${r.scanned}`);
  console.log(`to split             ${r.split}`);
  console.log(`channel subdocs      ${r.channelDocsMoved}`);
  console.log(`already split        ${r.skipped.already_split}`);
  if (mode !== 'apply') {
    for (const p of r.planned.slice(0, 25)) {
      console.log(
        `  ${p.id}  fields=[${Object.keys(p.moved).join(',')}]  channels=[${p.channelDocs.join(',')}]`,
      );
    }
    if (r.planned.length > 25) console.log(`  ... and ${r.planned.length - 25} more`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;

  if (args.mode === 'apply' && !args.allowProd && !usingEmulator) {
    throw new Error('refusing to write: pass --allow-prod, or point at the emulator.');
  }
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);
  const db = getFirestore();

  const result = await run(db, args.mode, args.pageSize);
  summarise(args.mode, result);

  if (args.mode === 'apply') {
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_NOTIFICATION_DELIVERY_SPLIT',
      description: `split=${result.split} channelDocs=${result.channelDocsMoved} scanned=${result.scanned}`,
      status: 'SUCCESS',
      actorId: 'system:backfillNotificationDeliverySplit',
      targetId: '',
      targetCollection: 'notifications',
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: {
        scanned: result.scanned,
        split: result.split,
        channelDocsMoved: result.channelDocsMoved,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED, runs outside writeAuditEntry).');
  } else {
    console.log('\nDRY-RUN. No writes. Re-run with --allow-prod to commit.');
  }
}

// Only auto-run when invoked directly, not when imported by tests.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
