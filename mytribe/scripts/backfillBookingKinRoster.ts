/**
 * backfillBookingKinRoster.ts
 *
 * OPERATOR RULING R1: "all KinCare sessions covers ALL KIN in the family …
 * KinCare rarely is split between the Kin in a home. IE. kinfolk has a dog and
 * a cat. The KinCare will always care for both the dog and cat."
 *
 * Every booking writer used to persist an omitted `kinIds` as the literal `[]`.
 * `mytribe/functions/src/lib/kinRoster.ts` now materializes the household's
 * roster at write time, so new documents are always explicit. This script is
 * the other half: the documents that were already written.
 *
 * THE AMBIGUITY, AND WHY IT IS NOT ACTUALLY AMBIGUOUS. `kinIds: []` could in
 * principle mean "whole household, stored badly" or "genuinely nobody". R1
 * removes the second reading: a KinCare visit that covers zero animals is not
 * something the business sells or an Auntie could perform. So an empty roster
 * on a booking means all of them, and this script says so out loud.
 *
 * ROSTER DRIFT, the part that needs care, because a household's roster CHANGES.
 * Stamping today's roster onto a session completed last March would assert that
 * a dog adopted in July was cared for in March. That is a fabricated care
 * record, and this corpus feeds KinTales and invoices. Two rules keep it honest:
 *
 *   1. A Kin created AFTER the booking was created is excluded, whenever both
 *      timestamps are readable. A Kin doc with no `createdAt` (legacy import,
 *      predates the field) cannot be dated and is included: the imports
 *      predate every booking in this corpus, so including them is the
 *      conservative reading, not a guess about a new adoption.
 *   2. A Kin who is `noLongerWithUs` is included on a booking that is already
 *      in the PAST (they were alive and in care then) and excluded from one
 *      still UPCOMING (nobody is walking them next Tuesday). The legacy admin
 *      `inactive`/`archived` spellings are excluded from both: those are not
 *      portal Kin at all.
 *
 * WHAT IT WRITES, and only this, and only where `kinIds` is currently empty or
 * absent:
 *   - `kinIds`    the materialized roster
 *   - `kinNames`  the matching display names, blank names omitted (the same
 *                 convention `resolveKinNames` already uses)
 *
 * across three shapes:
 *   - `families/{fid}/bookings/{batchId}`                    envelopes
 *   - `families/{fid}/bookings/{batchId}/kinCares/{visitId}` visits
 *   - `kin_care_sessions/{id}`                               the sessions an
 *                                                            Auntie actually runs
 *
 * IDEMPOTENT BY CONSTRUCTION. A document with a non-empty `kinIds` is never
 * touched, and after one run every document this script wrote has one, so a
 * second run plans nothing. A household with no Kin at all is reported and left
 * alone rather than written with an empty array that says nothing new.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order. FIRESTORE_EMULATOR_HOST does not turn a dry run into
 *                  a writing one; it stands in for credentials only.
 *
 * Runbook: DRY first, read the plan and the refusals, then re-run with
 * --allow-prod.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const SESSIONS_COLLECTION = 'kin_care_sessions';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked
  // separately from `args.mode` (rather than setting `args.mode = 'dry-run'`
  // inline the moment `--dry-run` is seen) because the unconditional
  // `if (args.allowProd) args.mode = 'apply'` below runs once, AFTER the
  // whole argv has been scanned — so `--allow-prod --dry-run` would silently
  // re-flip mode to 'apply' if this flag's own presence weren't remembered
  // past the loop. This is the one flag whose entire purpose is proving a run
  // is safe before it rewrites the roster on live bookings, visits and
  // sessions; getting its precedence backwards defeats that purpose.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`, which would take the safety flag off
      // the table while `--allow-prod` stayed on.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillBookingKinRoster.ts: materialize the whole-household Kin roster onto bookings, visits and sessions (R1)',
          '',
          '  npm run backfill:booking-kin-roster                    # DRY RUN (default)',
          '  npm run backfill:booking-kin-roster -- --allow-prod    # apply',
          '  npm run backfill:booking-kin-roster -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run backfill:booking-kin-roster -- --project <id>  # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // --allow-prod implies a real write run, UNLESS --dry-run was also given.
  // `args.allowProd` itself still reports `true` when `--allow-prod` was
  // passed, even though `mode` stays 'dry-run', so an operator who typed
  // `--allow-prod --dry-run` sees exactly what happened rather than a flag
  // that silently vanished.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/**
 * The memorial state. Still LISTED in the portal, but not in active care, which
 * is why it is time-dependent here rather than a flat exclusion.
 */
export const MEMORIAL_KIN_STATUS = 'noLongerWithUs';

/**
 * Legacy AuntieOS-only spellings, outside the portal's binary contract. Never
 * on a roster, past or future. Mirrors `functions/src/lib/kinStatus.ts`; this
 * script cannot import from the functions tree (separate tsconfig/module
 * graph), so the two constants are kept in step by name.
 */
export const LEGACY_INACTIVE_KIN_STATUSES: readonly string[] = ['inactive', 'archived'];

/** One Kin as this script reads it off `families/{fid}/kin/{kinId}`. */
export interface RosterKin {
  id: string;
  /** Null when the doc carries no usable name. */
  name: string | null;
  /** Raw `status`. Absent/unrecognized counts as active, per kinStatus.ts. */
  status: unknown;
  /** Epoch millis, or null when the doc predates the field. */
  createdAtMs: number | null;
}

export interface MaterializedRoster {
  kinIds: string[];
  kinNames: string[];
}

/**
 * The roster ONE document should carry. PURE: no Firestore access, so every
 * drift rule above is unit-testable against fixtures.
 *
 * `docCreatedAtMs` null means the booking carries no readable creation stamp,
 * so rule 1 cannot fire and no Kin is excluded on age.
 */
export function planKinRoster(opts: {
  roster: readonly RosterKin[];
  docCreatedAtMs: number | null;
  /** True when the visit has not happened yet. Drives the memorial rule. */
  upcoming: boolean;
}): MaterializedRoster {
  const eligible = opts.roster.filter((k) => {
    const status = typeof k.status === 'string' ? k.status : '';
    if (LEGACY_INACTIVE_KIN_STATUSES.includes(status)) return false;
    if (status === MEMORIAL_KIN_STATUS && opts.upcoming) return false;
    if (opts.docCreatedAtMs !== null && k.createdAtMs !== null && k.createdAtMs > opts.docCreatedAtMs) {
      return false;
    }
    return true;
  });
  return {
    kinIds: eligible.map((k) => k.id),
    kinNames: eligible.map((k) => k.name).filter((n): n is string => n !== null),
  };
}

/** True when the document's `kinIds` is absent or empty, i.e. eligible at all. */
export function needsRoster(data: Record<string, unknown>): boolean {
  const raw = data['kinIds'];
  if (!Array.isArray(raw)) return true;
  return raw.filter((v) => typeof v === 'string' && v.length > 0).length === 0;
}

/** Timestamp | Date | ISO string | epoch millis -> millis, or null. */
export function toMillis(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  if (v !== null && typeof v === 'object') {
    const o = v as { toMillis?: unknown; toDate?: unknown };
    if (typeof o.toMillis === 'function') {
      const ms = (o.toMillis as () => unknown)();
      return typeof ms === 'number' ? ms : null;
    }
    if (typeof o.toDate === 'function') {
      const d = (o.toDate as () => unknown)();
      return d instanceof Date ? d.getTime() : null;
    }
  }
  return null;
}

function nameOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export interface PlannedWrite {
  path: string;
  update: MaterializedRoster;
}

export interface Refusal {
  path: string;
  reason: 'household-has-no-kin' | 'roster-empty-at-that-date';
}

export interface Summary {
  households: number;
  envelopesScanned: number;
  visitsScanned: number;
  sessionsScanned: number;
  alreadyExplicit: number;
  toWrite: number;
  refusals: Refusal[];
}

/**
 * Reads one household's Kin subcollection into the shape [planKinRoster] wants.
 * Exported so the emulator test can seed and assert against the same reader.
 */
export async function readRoster(db: Firestore, kinfolkId: string): Promise<RosterKin[]> {
  const snap = await db.collection('families').doc(kinfolkId).collection('kin').get();
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: nameOrNull(data['name']),
      status: data['status'],
      createdAtMs: toMillis(data['createdAt']),
    };
  });
}

export async function buildPlan(
  db: Firestore,
  nowMs: number = Date.now(),
): Promise<{ summary: Summary; writes: PlannedWrite[] }> {
  const summary: Summary = {
    households: 0,
    envelopesScanned: 0,
    visitsScanned: 0,
    sessionsScanned: 0,
    alreadyExplicit: 0,
    toWrite: 0,
    refusals: [],
  };
  const writes: PlannedWrite[] = [];

  const families = await db.collection('families').get();
  for (const family of families.docs) {
    summary.households += 1;
    const roster = await readRoster(db, family.id);

    /** Shared per-document decision, used by all three shapes below. */
    const consider = (
      path: string,
      data: Record<string, unknown>,
      startMs: number | null,
      createdMs: number | null,
    ): void => {
      if (!needsRoster(data)) {
        summary.alreadyExplicit += 1;
        return;
      }
      if (roster.length === 0) {
        summary.refusals.push({ path, reason: 'household-has-no-kin' });
        return;
      }
      const planned = planKinRoster({
        roster,
        docCreatedAtMs: createdMs,
        upcoming: startMs === null ? false : startMs >= nowMs,
      });
      if (planned.kinIds.length === 0) {
        // Every Kin on file postdates this booking, or all of them are
        // memorial and the visit is still ahead. Writing `[]` would say
        // nothing the document does not already say, so it is left alone and
        // named for a person to look at.
        summary.refusals.push({ path, reason: 'roster-empty-at-that-date' });
        return;
      }
      summary.toWrite += 1;
      writes.push({ path, update: planned });
    };

    const envelopes = await db
      .collection('families')
      .doc(family.id)
      .collection('bookings')
      .get();
    for (const envelope of envelopes.docs) {
      summary.envelopesScanned += 1;
      const data = envelope.data() as Record<string, unknown>;
      const createdMs = toMillis(data['createdAt']);
      consider(envelope.ref.path, data, toMillis(data['firstStartTime']), createdMs);

      const visits = await envelope.ref.collection('kinCares').get();
      for (const visit of visits.docs) {
        summary.visitsScanned += 1;
        const vdata = visit.data() as Record<string, unknown>;
        consider(
          visit.ref.path,
          vdata,
          toMillis(vdata['startTime']),
          // A visit predates nothing its envelope does not; fall back to the
          // envelope's stamp when the child carries none.
          toMillis(vdata['createdAt']) ?? createdMs,
        );
      }
    }

    const sessions = await db
      .collection(SESSIONS_COLLECTION)
      .where('kinfolkId', '==', family.id)
      .get();
    for (const session of sessions.docs) {
      summary.sessionsScanned += 1;
      const data = session.data() as Record<string, unknown>;
      consider(
        session.ref.path,
        data,
        toMillis(data['startTime']),
        toMillis(data['createdAt']),
      );
    }
  }

  return { summary, writes };
}

function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== R1 whole-household Kin roster backfill (${mode.toUpperCase()}) ===`);
  console.log(`households scanned           : ${summary.households}`);
  console.log(`booking envelopes scanned    : ${summary.envelopesScanned}`);
  console.log(`visits scanned               : ${summary.visitsScanned}`);
  console.log(`sessions scanned             : ${summary.sessionsScanned}`);
  console.log(`already explicit (untouched) : ${summary.alreadyExplicit}`);
  console.log(`to materialize               : ${summary.toWrite}`);
  console.log(`refused (left untouched)     : ${summary.refusals.length}`);

  if (writes.length > 0) {
    console.log('');
    console.log('-- planned writes --');
    for (const w of writes) {
      console.log(`  ${w.path}  kinIds=[${w.update.kinIds.join(', ')}]  kinNames=[${w.update.kinNames.join(', ')}]`);
    }
  }

  if (summary.refusals.length > 0) {
    console.log('');
    console.log('-- REFUSED. Left exactly as they are; nothing was invented. --');
    console.log('   household-has-no-kin       : no Kin docs on the family at all.');
    console.log('   roster-empty-at-that-date  : every Kin on file postdates this booking,');
    console.log('                                or all of them are memorial and the visit');
    console.log('                                is still ahead. Needs a person.');
    for (const r of summary.refusals) {
      console.log(`  ${r.path}  ${r.reason}`);
    }
  }
  console.log('');
}

/** Applies the plan. Exported so the emulator test can prove the write lands. */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  // One merge per document. 400 keeps a wide margin under the 500-op limit.
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      // merge, never set: these documents carry rollup counts, statuses and
      // assignment state no shape here declares, and a bare set() would delete
      // every one of them.
      batch.set(db.doc(w.path), { kinIds: w.update.kinIds, kinNames: w.update.kinNames }, { merge: true });
    }
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !args.allowProd && !emulator) {
    throw new Error('refusing to write without --allow-prod (or FIRESTORE_EMULATOR_HOST)');
  }
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error(
      'a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)',
    );
  }
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const { summary, writes } = await buildPlan(db);
  report(summary, writes, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  await applyPlan(db, writes);
  console.log(`APPLIED: ${writes.length} document(s) materialized.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
