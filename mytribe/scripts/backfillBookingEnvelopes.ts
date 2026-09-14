/**
 * backfillBookingEnvelopes.ts
 *
 * One-off Firestore backfill that wraps legacy FLAT booking docs into the
 * Booking ENVELOPE model.
 *
 * Historically a kinfolk booking request wrote one flat doc per visit at
 * `families/{fid}/bookings/{oldDocId}` (see requestBooking.ts legacy path).
 * The envelope model splits that into:
 *   - a PARENT envelope `families/{fid}/bookings/{batchId}` carrying rollup
 *     counts + status across the whole request, and
 *   - one PER-VISIT doc `families/{fid}/bookings/{batchId}/kinCares/{visitId}`
 *     carrying the individual visit fields.
 *
 * This script scans flat family booking docs that still carry the OLD shape
 * (has startTime, no envelopeStatus/visitCount, not already migrated). For each:
 *   - batchId = its `requestBatchId` if present (so co-batched legacy docs
 *     collapse into ONE envelope) else `legacy_{oldDocId}`.
 *   - It writes/merges the parent envelope: accumulate visitCount, union kinIds,
 *     min/max first/lastStartTime, rolled-up envelopeStatus from visit statuses.
 *   - It writes a `kinCares/{oldDocId}` visit doc (preserve the old doc id as the
 *     visitId; copy per-visit fields; batchId set; sourceBookingId/sessionId null).
 *   - It copies the old doc's `notes/` and `internalNotes/` subcollections under
 *     the new kinCare path.
 *   - It marks the OLD flat doc with `migratedToBatchId` (does NOT delete it by
 *     default). Deletion of old flat docs happens only under --finalize.
 *
 * Idempotency: a flat doc that already carries `migratedToBatchId` is skipped.
 * The parent envelope and kinCare writes are merge:true on deterministic ids, so
 * re-running re-converges. The rollup counts are computed from the FULL set of
 * legacy docs in a batch each run (not incremented blindly), so a partial prior
 * run cannot double-count.
 *
 * Modes:
 *   default        — dry-run, prints planned changes to stdout, no writes
 *   --allow-prod   — performs the envelope + kinCare writes and stamps the old
 *                    flat doc with migratedToBatchId (does NOT delete)
 *   --finalize     — (only meaningful with --allow-prod) also DELETES the old
 *                    flat docs after a successful migration
 *
 * Safety:
 *   - Dry-run by default; refuses to write unless `--allow-prod` is passed. An
 *     explicit `--dry-run` beats `--allow-prod` in either flag order, and
 *     disarms `--finalize` with it, so `--allow-prod --finalize --dry-run`
 *     deletes nothing. FIRESTORE_EMULATOR_HOST does NOT relieve that: it only
 *     stands in for credentials, so an emulator run without --allow-prod is
 *     still a dry run that writes nothing, to the emulator or anywhere else.
 *   - When writing to prod, requires GOOGLE_APPLICATION_CREDENTIALS (fail-loud).
 *   - Pure exported planner (`planEnvelope`) carries all the migration logic so
 *     determinism, rollup correctness, and the idempotency skip are unit-tested
 *     with no Firestore deps.
 */

import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  finalize: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, finalize: false, projectId: null };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked
  // separately from `args.mode` (rather than setting `args.mode = 'dry-run'`
  // inline the moment `--dry-run` is seen) because the unconditional
  // `if (args.allowProd) args.mode = 'apply'` below runs once, AFTER the
  // whole argv has been scanned — so `--allow-prod --dry-run` would silently
  // re-flip mode to 'apply' if this flag's own presence weren't remembered
  // past the loop. Under `--finalize` this script DELETES the legacy flat
  // booking docs, so a dry run is the only way to read the plan while the
  // originals still exist; getting this flag's precedence backwards defeats
  // the entire point of asking for one.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--finalize') args.finalize = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`, which would take the safety flag off
      // the table while `--allow-prod --finalize` stayed on.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillBookingEnvelopes.ts — wrap legacy flat booking docs into envelopes',
          '',
          'Usage:',
          '  ts-node backfillBookingEnvelopes.ts                  # dry-run (default)',
          '  ts-node backfillBookingEnvelopes.ts --allow-prod     # write envelopes + kinCares, stamp old docs',
          '  ts-node backfillBookingEnvelopes.ts --allow-prod --finalize  # also delete old flat docs',
          '  ts-node backfillBookingEnvelopes.ts --dry-run        # force dry-run, ALWAYS wins',
          '  ts-node backfillBookingEnvelopes.ts --project <id>   # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line, and disarms --finalize with it (e.g.',
          '"--allow-prod --finalize --dry-run" deletes nothing).',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (or ADC)',
          '  GCLOUD_PROJECT                  Firebase project id',
          '  FIRESTORE_EMULATOR_HOST         when set, credentials are not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // --allow-prod implies a real write run, UNLESS --dry-run was also given.
  // `args.allowProd` itself still reports `true` when `--allow-prod` was
  // passed, even though `mode` stays 'dry-run': the startup log line prints
  // both, so an operator who typed `--allow-prod --dry-run` sees exactly what
  // happened rather than a flag that silently vanished.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

// ---------------------------------------------------------------------------
// Status vocab (mirrors the envelope model contract).
// ---------------------------------------------------------------------------
export type VisitStatus =
  | 'requested'
  | 'confirmed'
  | 'enRoute'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'unavailable';

export type EnvelopeStatus =
  | 'requested'
  | 'partiallyConfirmed'
  | 'confirmed'
  | 'inProgress'
  | 'completed'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Inputs to the pure planner. A "legacy flat doc" is one old booking doc as it
// exists today at `families/{fid}/bookings/{oldDocId}`. Timestamps are passed as
// epoch-millis numbers so the planner stays Firestore-free and deterministic.
// ---------------------------------------------------------------------------
export interface LegacyFlatDoc {
  /** The old flat doc id. Preserved as the kinCare visitId. */
  oldDocId: string;
  /** Raw field bag from the flat doc (status, startTime, kinIds, etc.). */
  data: Record<string, unknown>;
}

/** A single planned Firestore write produced by the planner. Pure data. */
export interface PlannedWrite {
  path: string;
  data: Record<string, unknown>;
  /** merge:true unless this is a fresh overwrite. Always true here. */
  merge: true;
}

/** The migration plan for one envelope (one batchId within one family). */
export interface EnvelopePlan {
  familyId: string;
  batchId: string;
  /** Visit ids (old flat doc ids) that roll up into this envelope. */
  visitIds: string[];
  parentWrite: PlannedWrite;
  visitWrites: PlannedWrite[];
  /** Old flat doc ids to stamp with migratedToBatchId. */
  stampOldDocIds: string[];
}

/** Per-doc planner decision (for idempotency reporting). */
export type DocDecision =
  | { action: 'migrate'; familyId: string; oldDocId: string; batchId: string }
  | { action: 'skip'; reason: string; familyId: string; oldDocId: string };

// ---------------------------------------------------------------------------
// Field helpers — tolerant readers over the loose legacy bag.
// ---------------------------------------------------------------------------
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Normalize a legacy startTime/endTime/createdAt value to epoch-millis.
 * Accepts a plain number (epoch ms), a Firestore Timestamp-like object
 * (`{ toMillis() }` or `{ _seconds, _nanoseconds }` / `{ seconds, nanoseconds }`),
 * or a Date. Returns null when unparseable.
 */
export function tsToMillis(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.toMillis === 'function') {
      const m = (o.toMillis as () => number)();
      return Number.isFinite(m) ? m : null;
    }
    const secs =
      typeof o._seconds === 'number'
        ? o._seconds
        : typeof o.seconds === 'number'
          ? o.seconds
          : null;
    const nanos =
      typeof o._nanoseconds === 'number'
        ? o._nanoseconds
        : typeof o.nanoseconds === 'number'
          ? o.nanoseconds
          : 0;
    if (secs != null) return secs * 1000 + Math.floor(nanos / 1e6);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection — does this flat doc have the OLD shape and still need migrating?
// ---------------------------------------------------------------------------
/**
 * True when a flat booking doc is a legacy doc that has NOT been migrated yet.
 * Criteria (per task): has startTime, has NO envelopeStatus, has NO visitCount,
 * and is NOT already carrying migratedToBatchId.
 */
export function isUnmigratedLegacyDoc(data: Record<string, unknown>): boolean {
  if (data == null) return false;
  if (asString(data.migratedToBatchId) != null) return false; // already migrated
  if ('envelopeStatus' in data && data.envelopeStatus != null) return false; // already an envelope
  if ('visitCount' in data && data.visitCount != null) return false; // already an envelope
  if (!('startTime' in data) || data.startTime == null) return false; // not a visit doc
  return true;
}

// ---------------------------------------------------------------------------
// Rollup — derive the envelope status from the set of visit statuses.
//
// Rules (in priority order, evaluated over the non-cancelled visits where it
// matters):
//   - every visit cancelled                       -> cancelled
//   - any visit in flight (enRoute|active)        -> inProgress
//   - all NON-cancelled visits completed          -> completed
//   - all NON-cancelled visits confirmed+         -> confirmed
//   - some confirmed, some still requested        -> partiallyConfirmed
//   - otherwise (all requested / unavailable)     -> requested
//
// `unavailable` is treated as "not yet confirmed" for the requested vs confirmed
// split, and never blocks a completed/inProgress rollup.
// ---------------------------------------------------------------------------
export function rollupEnvelopeStatus(statuses: VisitStatus[]): EnvelopeStatus {
  if (statuses.length === 0) return 'requested';

  const active = statuses.filter((s) => s !== 'cancelled');
  if (active.length === 0) return 'cancelled';

  if (active.some((s) => s === 'enRoute' || s === 'active')) return 'inProgress';

  if (active.every((s) => s === 'completed')) return 'completed';

  // "confirmed or better" for the confirmed/partial split.
  const isConfirmedPlus = (s: VisitStatus): boolean =>
    s === 'confirmed' || s === 'completed';
  if (active.every(isConfirmedPlus)) return 'confirmed';

  if (active.some(isConfirmedPlus)) return 'partiallyConfirmed';

  return 'requested';
}

// ---------------------------------------------------------------------------
// batchId derivation. Deterministic: prefer the legacy requestBatchId so
// co-batched docs collapse into ONE envelope; else legacy_{oldDocId}.
// ---------------------------------------------------------------------------
export function deriveBatchId(oldDocId: string, data: Record<string, unknown>): string {
  const rb = asString(data.requestBatchId);
  return rb ?? `legacy_${oldDocId}`;
}

// ---------------------------------------------------------------------------
// Per-visit (kinCare) doc builder. Preserves per-visit fields; stamps batchId;
// sets sourceBookingId/sessionId null (AuntieOS fills these later).
// ---------------------------------------------------------------------------
function buildVisitDoc(
  familyId: string,
  batchId: string,
  oldDocId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const status = (asString(data.status) as VisitStatus | null) ?? 'requested';
  const serviceName = asString(data.serviceName) ?? asString(data.serviceType) ?? null;
  return {
    batchId,
    familyId,
    status,
    visitProgress: data.visitProgress ?? null,
    serviceId: asString(data.serviceId),
    serviceName,
    // serviceType mirrors serviceName per the envelope contract.
    serviceType: serviceName,
    priceCents: asNumberOrNull(data.priceCents),
    title: asString(data.title) ?? serviceName,
    startTime: data.startTime ?? null,
    endTime: data.endTime ?? null,
    kinIds: asStringArray(data.kinIds),
    kinNames: asStringArray(data.kinNames),
    auntieDisplayName: asString(data.auntieDisplayName),
    auntieAvatarUrl: asString(data.auntieAvatarUrl),
    requestedByUid: asString(data.requestedByUid),
    // AuntieOS writes these later; never inherit a stale value from the flat doc.
    sourceBookingId: null,
    sessionId: null,
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// The PURE planner. Given a familyId, a batchId, and the FULL set of legacy
// flat docs that share that batch, produce the parent envelope + per-visit
// writes + the list of old doc ids to stamp.
//
// Computes counts over the whole batch each run so a re-run re-converges
// (idempotent rollup, no blind increment).
// ---------------------------------------------------------------------------
export function planEnvelope(
  familyId: string,
  batchId: string,
  legacyDocs: LegacyFlatDoc[],
): EnvelopePlan {
  if (legacyDocs.length === 0) {
    throw new Error(`planEnvelope: empty legacyDocs for ${familyId}/${batchId}`);
  }

  // Deterministic order: sort by startTime then oldDocId so first/last and the
  // representative parent fields are stable regardless of scan order.
  const sorted = [...legacyDocs].sort((a, b) => {
    const am = tsToMillis(a.data.startTime) ?? 0;
    const bm = tsToMillis(b.data.startTime) ?? 0;
    if (am !== bm) return am - bm;
    return a.oldDocId < b.oldDocId ? -1 : a.oldDocId > b.oldDocId ? 1 : 0;
  });

  const statuses: VisitStatus[] = sorted.map(
    (d) => (asString(d.data.status) as VisitStatus | null) ?? 'requested',
  );

  // Rollup counts.
  const visitCount = sorted.length;
  const confirmedCount = statuses.filter(
    (s) => s === 'confirmed' || s === 'enRoute' || s === 'active' || s === 'completed',
  ).length;
  const completedCount = statuses.filter((s) => s === 'completed').length;
  const cancelledCount = statuses.filter((s) => s === 'cancelled').length;

  // kinIds union (stable order: first-seen across the sorted docs).
  const kinIdSet = new Set<string>();
  const kinNameSet = new Set<string>();
  for (const d of sorted) {
    for (const k of asStringArray(d.data.kinIds)) kinIdSet.add(k);
    for (const n of asStringArray(d.data.kinNames)) kinNameSet.add(n);
  }

  // first/last startTime: min/max across the batch (carry the original
  // Timestamp value, not the millis, so the parent stores a real Timestamp).
  let firstDoc = sorted[0];
  let lastDoc = sorted[0];
  let firstMs = tsToMillis(firstDoc.data.startTime);
  let lastMs = tsToMillis(lastDoc.data.startTime);
  for (const d of sorted) {
    const m = tsToMillis(d.data.startTime);
    if (m == null) continue;
    if (firstMs == null || m < firstMs) {
      firstMs = m;
      firstDoc = d;
    }
    if (lastMs == null || m > lastMs) {
      lastMs = m;
      lastDoc = d;
    }
  }

  // Representative request-level fields come from the earliest doc.
  const rep = firstDoc.data;
  const repService = asString(rep.serviceName) ?? asString(rep.serviceType) ?? null;
  const pattern = asString(rep.pattern) ?? 'individual';
  const weeklyDaysRaw = rep.weeklyDays;
  const weeklyDays = Array.isArray(weeklyDaysRaw)
    ? weeklyDaysRaw.filter((x): x is number => typeof x === 'number')
    : null;

  const parentData: Record<string, unknown> = {
    familyId,
    requestBatchId: batchId,
    envelopeStatus: rollupEnvelopeStatus(statuses),
    requestedByUid: asString(rep.requestedByUid),
    pattern,
    weeklyDays,
    serviceId: asString(rep.serviceId),
    serviceName: repService,
    kinIds: [...kinIdSet],
    kinNames: [...kinNameSet],
    notes: asString(rep.notes),
    visitCount,
    confirmedCount,
    completedCount,
    cancelledCount,
    firstStartTime: firstDoc.data.startTime ?? null,
    lastStartTime: lastDoc.data.startTime ?? null,
    createdAt: rep.createdAt ?? null,
    updatedAt: rep.updatedAt ?? null,
    targetType: asString(rep.targetType) ?? 'KIN',
    // Provenance marker so a backfilled envelope is distinguishable from a
    // natively-written one (and so a re-scan never treats it as legacy).
    backfilledFromLegacy: true,
  };

  const visitWrites: PlannedWrite[] = sorted.map((d) => ({
    path: `families/${familyId}/bookings/${batchId}/kinCares/${d.oldDocId}`,
    data: buildVisitDoc(familyId, batchId, d.oldDocId, d.data),
    merge: true,
  }));

  return {
    familyId,
    batchId,
    visitIds: sorted.map((d) => d.oldDocId),
    parentWrite: {
      path: `families/${familyId}/bookings/${batchId}`,
      data: parentData,
      merge: true,
    },
    visitWrites,
    stampOldDocIds: sorted.map((d) => d.oldDocId),
  };
}

/**
 * Group a family's flat docs into per-batch EnvelopePlans, skipping docs that
 * are not unmigrated-legacy. Returns the plans plus per-doc decisions. Pure.
 */
export function planFamily(
  familyId: string,
  flatDocs: LegacyFlatDoc[],
): { plans: EnvelopePlan[]; decisions: DocDecision[] } {
  const decisions: DocDecision[] = [];
  const byBatch = new Map<string, LegacyFlatDoc[]>();

  for (const doc of flatDocs) {
    if (!isUnmigratedLegacyDoc(doc.data)) {
      const reason = asString(doc.data.migratedToBatchId)
        ? 'already_migrated'
        : 'not_legacy_shape';
      decisions.push({ action: 'skip', reason, familyId, oldDocId: doc.oldDocId });
      continue;
    }
    const batchId = deriveBatchId(doc.oldDocId, doc.data);
    decisions.push({ action: 'migrate', familyId, oldDocId: doc.oldDocId, batchId });
    const list = byBatch.get(batchId) ?? [];
    list.push(doc);
    byBatch.set(batchId, list);
  }

  // Deterministic batch ordering for stable output.
  const plans = [...byBatch.keys()]
    .sort()
    .map((batchId) => planEnvelope(familyId, batchId, byBatch.get(batchId) as LegacyFlatDoc[]));

  return { plans, decisions };
}

// ---------------------------------------------------------------------------
// Firestore I/O. Everything below this line is impure and untested by vitest;
// all decision logic lives in the pure planner above.
// ---------------------------------------------------------------------------
function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillBookingEnvelopes: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (!getApps().length) initializeApp({ projectId });
}

interface RunResult {
  familiesScanned: number;
  docsScanned: number;
  envelopesWritten: number;
  visitsWritten: number;
  notesCopied: number;
  oldDocsStamped: number;
  oldDocsDeleted: number;
  skipped: Record<string, number>;
}

function bumpSkip(r: RunResult, reason: string): void {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + 1;
}

/** Copy `notes/` and `internalNotes/` from the old flat doc to the kinCare path. */
async function copyNoteSubcollections(
  db: Firestore,
  familyId: string,
  batchId: string,
  oldDocId: string,
  mode: Mode,
): Promise<number> {
  let copied = 0;
  for (const sub of ['notes', 'internalNotes']) {
    const srcCol = db.collection(`families/${familyId}/bookings/${oldDocId}/${sub}`);
    const srcSnap = await srcCol.get();
    for (const noteSnap of srcSnap.docs) {
      const destPath = `families/${familyId}/bookings/${batchId}/kinCares/${oldDocId}/${sub}/${noteSnap.id}`;
      console.log(`[note] ${noteSnap.ref.path} -> ${destPath}`);
      if (mode === 'apply') {
        await db.doc(destPath).set(noteSnap.data(), { merge: true });
      }
      copied += 1;
    }
  }
  return copied;
}

async function run(mode: Mode, finalize: boolean): Promise<RunResult> {
  const db = getFirestore();
  const result: RunResult = {
    familiesScanned: 0,
    docsScanned: 0,
    envelopesWritten: 0,
    visitsWritten: 0,
    notesCopied: 0,
    oldDocsStamped: 0,
    oldDocsDeleted: 0,
    skipped: {},
  };

  const familiesSnap = await db.collection('families').get();
  for (const famDoc of familiesSnap.docs) {
    const familyId = famDoc.id;
    result.familiesScanned += 1;

    const bookingsSnap = await db.collection(`families/${familyId}/bookings`).get();
    const flatDocs: LegacyFlatDoc[] = [];
    for (const b of bookingsSnap.docs) {
      result.docsScanned += 1;
      flatDocs.push({ oldDocId: b.id, data: b.data() as Record<string, unknown> });
    }
    if (flatDocs.length === 0) continue;

    const { plans, decisions } = planFamily(familyId, flatDocs);
    for (const d of decisions) {
      if (d.action === 'skip') {
        bumpSkip(result, d.reason);
        console.log(`[skip:${d.reason}] families/${familyId}/bookings/${d.oldDocId}`);
      }
    }

    for (const plan of plans) {
      console.log(
        `[envelope] ${plan.parentWrite.path}  visits=${plan.visitIds.length}  status=${plan.parentWrite.data.envelopeStatus}`,
      );
      if (mode === 'apply') {
        await db.doc(plan.parentWrite.path).set(plan.parentWrite.data, { merge: true });
      }
      result.envelopesWritten += 1;

      for (const vw of plan.visitWrites) {
        console.log(`[visit] ${vw.path}  status=${vw.data.status}`);
        if (mode === 'apply') {
          await db.doc(vw.path).set(vw.data, { merge: true });
        }
        result.visitsWritten += 1;
      }

      // Copy notes/internalNotes for each migrated visit.
      for (const oldDocId of plan.visitIds) {
        result.notesCopied += await copyNoteSubcollections(
          db,
          familyId,
          plan.batchId,
          oldDocId,
          mode,
        );
      }

      // Stamp (and optionally delete) the old flat docs only after writes.
      for (const oldDocId of plan.stampOldDocIds) {
        const oldRef = db.doc(`families/${familyId}/bookings/${oldDocId}`);
        // Never stamp/delete the parent envelope path itself: when batchId came
        // from requestBatchId, the envelope id differs from every oldDocId, so
        // there is no collision. When batchId == legacy_{oldDocId}, the envelope
        // lives at a DIFFERENT path than the old doc, so this is always safe.
        console.log(`[stamp] ${oldRef.path} migratedToBatchId=${plan.batchId}`);
        if (mode === 'apply') {
          await oldRef.set(
            { migratedToBatchId: plan.batchId, migratedAt: new Date().toISOString() },
            { merge: true },
          );
          result.oldDocsStamped += 1;
          if (finalize) {
            await oldRef.delete();
            result.oldDocsDeleted += 1;
            console.log(`[delete] ${oldRef.path}`);
          }
        }
      }
    }
  }

  return result;
}

function summarise(r: RunResult): void {
  console.log('\n=== backfillBookingEnvelopes ===');
  console.log(`  familiesScanned  : ${r.familiesScanned}`);
  console.log(`  docsScanned      : ${r.docsScanned}`);
  console.log(`  envelopesWritten : ${r.envelopesWritten}`);
  console.log(`  visitsWritten    : ${r.visitsWritten}`);
  console.log(`  notesCopied      : ${r.notesCopied}`);
  console.log(`  oldDocsStamped   : ${r.oldDocsStamped}`);
  console.log(`  oldDocsDeleted   : ${r.oldDocsDeleted}`);
  console.log(`  skipped          :`);
  for (const [reason, n] of Object.entries(r.skipped)) {
    console.log(`    ${reason}: ${n}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(
    `Mode: ${args.mode}    allowProd=${args.allowProd}    finalize=${args.finalize}    emulator=${usingEmulator}`,
  );

  if (args.finalize && args.mode !== 'apply') {
    console.log('Note: --finalize has no effect without --allow-prod (dry-run deletes nothing).');
  }

  if (args.mode === 'apply' && !args.allowProd && !usingEmulator) {
    throw new Error(
      'backfillBookingEnvelopes: refusing to write — pass --allow-prod or set FIRESTORE_EMULATOR_HOST',
    );
  }

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);

  const result = await run(args.mode, args.finalize);
  summarise(result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_BOOKING_ENVELOPES',
      description: `envelopes=${result.envelopesWritten} visits=${result.visitsWritten} stamped=${result.oldDocsStamped} deleted=${result.oldDocsDeleted}`,
      status: 'SUCCESS',
      actorId: 'system:backfillBookingEnvelopes',
      targetId: '',
      targetCollection: 'families',
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result, finalize: args.finalize },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED — runs outside writeAuditEntry).');
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
