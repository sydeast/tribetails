/**
 * backfillGoogleBusySlotZone.ts
 *
 * Rewrites Google Calendar busy imports stored before #1160 into the shape the
 * sync writes now: the business's wall clock plus the real instants.
 *
 * ── WHAT IS WRONG IN THE DATA ─────────────────────────────────────────────
 *
 * Before #1160, `syncGoogleCalendarBusyEvents` wrote each busy interval's
 * `date`/`startTime`/`endTime` from `toISOString()`, which is UTC. Every admin
 * client draws `booking_time_slots` on the business's clock, so for a Chicago
 * business those rows sit five or six hours away from the real busy time. The
 * server guard and Android's busy check still read them correctly (a row with
 * no `startMs` is read as UTC); only the drawing is wrong.
 *
 * ── WHY A SYNC IS NOT ENOUGH ON ITS OWN ───────────────────────────────────
 *
 * The next sync rewrites a legacy row in place, because the first day's dedupe
 * key is unchanged. But it only sees intervals still on the calendar between
 * now and its look-ahead. It never reaches:
 *   - rows for busy time that is already past, which draw wrong on past weeks;
 *   - rows whose Google event was moved or deleted, which the sync never
 *     removes (they draw wrong AND still block bookings);
 *   - rows past the current look-ahead, left by an earlier, longer sync.
 *
 * ── WHAT IT WRITES ────────────────────────────────────────────────────────
 *
 * Only rows with `source: 'GOOGLE_BUSY_IMPORT'` and no usable `startMs`/`endMs`.
 * Each is read as UTC (`legacyUtcWindow`, the same reading the server guard
 * uses), then re-derived by `slotsForInstants`, the function the sync itself
 * uses, in the zone from `business_settings/business_settings` (America/Chicago
 * when unset):
 *
 *   the row itself   update() of `date`, `startTime`, `endTime`, `startMs`,
 *                    `endMs`, `timeZone` to the first business day. Nothing
 *                    else on it changes, the dedupe key included.
 *   later days       when the window crosses business midnight, one NEW row per
 *                    later business day, keyed `<the row's key>_d1`, `_d2`, the
 *                    keys the sync gives them, carrying the row's own
 *                    `externalCalendarId` and `createdAt`. A key that already
 *                    exists in the collection is not created twice.
 *
 * A legacy row whose strings do not parse is reported by id and left alone.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * A rewritten row carries `startMs`, so a second run plans nothing.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 *
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --apply        writes, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --apply in either flag order.
 *   --allow-prod   the target is PRODUCTION. Required to touch production at
 *                  all, and REFUSED when FIRESTORE_EMULATOR_HOST is set.
 *                  --allow-prod says WHERE, --apply says WHETHER TO WRITE.
 *
 * Usage (the operator runs this against prod; an agent session does not):
 *
 *   npm --prefix mytribe/functions run backfill:google-busy-zone -- --project auntieos-ttpc --allow-prod
 *   npm --prefix mytribe/functions run backfill:google-busy-zone -- --project auntieos-ttpc --allow-prod --apply
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login), or
 * FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846).
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  legacyUtcWindow,
  slotsForInstants,
  storedInstants,
  type BookingTimeSlotDoc,
} from '../functions/src/lib/googleBusySlot';
import { businessTimeZone } from '../functions/src/lib/bookingTimeBlocks';

export const SLOTS_COLLECTION = 'booking_time_slots';
export const SETTINGS_DOC = 'business_settings/business_settings';
const GOOGLE_BUSY_SOURCE = 'GOOGLE_BUSY_IMPORT';

/** Firestore's write limit per batch. */
export const BATCH_LIMIT = 500;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  apply: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, apply: false };
  // An explicit --dry-run ALWAYS wins, in either flag order.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillGoogleBusySlotZone.ts: rewrites pre-#1160 Google busy imports onto the business clock (#1160)',
          '',
          '  npm --prefix mytribe/functions run backfill:google-busy-zone -- --project <id> --allow-prod',
          '  npm --prefix mytribe/functions run backfill:google-busy-zone -- --project <id> --allow-prod --apply',
          '',
          'Dry run unless --apply. --dry-run forces it back and wins in either flag order.',
          '--allow-prod says the target is production; it is refused when FIRESTORE_EMULATOR_HOST is set.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (explicitDryRun) args.apply = false;
  return args;
}

export type Target = { kind: 'emulator'; host: string } | { kind: 'production' };

/** Throws when the flags and the environment disagree about where the writes would go. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host && args.allowProd) {
    throw new Error(
      `--allow-prod refused: FIRESTORE_EMULATOR_HOST is set (${host}), so this would touch the emulator, not production. ` +
        'Unset FIRESTORE_EMULATOR_HOST to reach production, or drop --allow-prod to work against the emulator.',
    );
  }
  if (host) return { kind: 'emulator', host };
  if (!args.allowProd) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set, so this would reach PRODUCTION. Pass --allow-prod to confirm.');
  }
  return { kind: 'production' };
}

export function describeTarget(args: Args, env: Record<string, string | undefined>): string {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const project = args.projectId ?? '(default credentials project)';
  const mode = args.apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)';
  return host ? `EMULATOR at ${host}, project ${project} - ${mode}` : `PRODUCTION Firestore, project ${project} - ${mode}`;
}

/** The fields the row itself gets. */
export type RowUpdate = Pick<BookingTimeSlotDoc, 'date' | 'startTime' | 'endTime' | 'startMs' | 'endMs' | 'timeZone'>;

export type RowPlan =
  | { kind: 'skip'; reason: 'not-google' | 'already-has-instants' }
  | { kind: 'unreadable' }
  | { kind: 'rewrite'; update: RowUpdate; newRows: BookingTimeSlotDoc[] };

/**
 * The decision for ONE row. PURE: no Firestore access. `existingKeys` is every
 * `externalEventId` already in the collection, so a later-day row is never
 * created twice.
 */
export function planRow(
  data: Record<string, unknown>,
  timeZone: string,
  existingKeys: ReadonlySet<string>,
): RowPlan {
  if (data['source'] !== GOOGLE_BUSY_SOURCE) return { kind: 'skip', reason: 'not-google' };
  if (storedInstants(data) !== null) return { kind: 'skip', reason: 'already-has-instants' };
  const window = legacyUtcWindow(data['date'], data['startTime'], data['endTime']);
  if (!window) return { kind: 'unreadable' };

  const calendarId = typeof data['externalCalendarId'] === 'string' ? data['externalCalendarId'] : '';
  const createdAt = typeof data['createdAt'] === 'string' ? data['createdAt'] : new Date().toISOString();
  const pieces = slotsForInstants(window.startMs, window.endMs, calendarId, createdAt, timeZone);
  if (pieces.length === 0) return { kind: 'unreadable' };

  const [first, ...later] = pieces;
  // Later days are keyed off the row's OWN key, so they match what the next
  // sync would look up for the same interval.
  const ownKey = typeof data['externalEventId'] === 'string' && data['externalEventId'] !== '' ? data['externalEventId'] : first!.externalEventId;
  const newRows = later
    .map((piece, i) => ({ ...piece, externalEventId: `${ownKey}_d${i + 1}` }))
    .filter((piece) => !existingKeys.has(piece.externalEventId));
  return {
    kind: 'rewrite',
    update: {
      date: first!.date,
      startTime: first!.startTime,
      endTime: first!.endTime,
      startMs: first!.startMs,
      endMs: first!.endMs,
      timeZone: first!.timeZone,
    },
    newRows,
  };
}

export interface Report {
  timeZone: string;
  scanned: number;
  notGoogle: number;
  alreadyHasInstants: number;
  rewritten: number;
  newRows: number;
  unreadable: string[];
  samples: { id: string; before: string; after: string }[];
}

export interface Plan {
  report: Report;
  updates: { id: string; update: RowUpdate }[];
  creates: BookingTimeSlotDoc[];
}

/** Every row, decided. READS ONLY. */
export function buildPlanFromRows(
  rows: { id: string; data: Record<string, unknown> }[],
  timeZone: string,
): Plan {
  const existingKeys = new Set(
    rows.map((r) => r.data['externalEventId']).filter((k): k is string => typeof k === 'string' && k !== ''),
  );
  const report: Report = {
    timeZone,
    scanned: 0,
    notGoogle: 0,
    alreadyHasInstants: 0,
    rewritten: 0,
    newRows: 0,
    unreadable: [],
    samples: [],
  };
  const updates: Plan['updates'] = [];
  const creates: BookingTimeSlotDoc[] = [];
  for (const row of rows) {
    report.scanned += 1;
    const plan = planRow(row.data, timeZone, existingKeys);
    if (plan.kind === 'skip') {
      if (plan.reason === 'not-google') report.notGoogle += 1;
      else report.alreadyHasInstants += 1;
      continue;
    }
    if (plan.kind === 'unreadable') {
      report.unreadable.push(row.id);
      continue;
    }
    report.rewritten += 1;
    report.newRows += plan.newRows.length;
    updates.push({ id: row.id, update: plan.update });
    for (const r of plan.newRows) existingKeys.add(r.externalEventId);
    creates.push(...plan.newRows);
    if (report.samples.length < 20) {
      report.samples.push({
        id: row.id,
        before: `${String(row.data['date'])} ${String(row.data['startTime'])}-${String(row.data['endTime'])} UTC`,
        after:
          `${plan.update.date} ${plan.update.startTime}-${plan.update.endTime}` +
          (plan.newRows.length > 0 ? ` (+${plan.newRows.length} later day row(s))` : ''),
      });
    }
  }
  return { report, updates, creates };
}

export async function buildPlan(db: Firestore): Promise<Plan> {
  const settings = await db.doc(SETTINGS_DOC).get();
  const timeZone = businessTimeZone(settings.data());
  const snap = await db.collection(SLOTS_COLLECTION).get();
  return buildPlanFromRows(
    snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
    timeZone,
  );
}

export function reportLines(report: Report, applied: boolean): string[] {
  const lines = [
    '',
    `=== Google busy import zone backfill (${applied ? 'APPLIED' : 'DRY RUN'}) ===`,
    `business zone                     : ${report.timeZone}`,
    `slots scanned                     : ${report.scanned}`,
    `not a Google import (untouched)   : ${report.notGoogle}`,
    `already has instants (untouched)  : ${report.alreadyHasInstants}`,
    `legacy UTC rows rewritten         : ${report.rewritten}`,
    `new later-day rows                : ${report.newRows}`,
    `unreadable legacy rows (skipped)  : ${report.unreadable.length}`,
  ];
  if (report.samples.length > 0) {
    lines.push('', '-- sample rewrites --');
    for (const s of report.samples) lines.push(`  ${SLOTS_COLLECTION}/${s.id}  ${s.before}  ->  ${s.after}`);
  }
  if (report.unreadable.length > 0) {
    lines.push('', '-- unreadable, left alone --');
    for (const id of report.unreadable) lines.push(`  ${SLOTS_COLLECTION}/${id}`);
  }
  lines.push('');
  if (!applied) lines.push('DRY RUN: nothing was written. Re-run with --apply to write.');
  return lines;
}

export async function applyPlan(db: Firestore, plan: Plan): Promise<void> {
  const ops: ((batch: ReturnType<Firestore['batch']>) => void)[] = [
    // update(), never set(): the row keeps its dedupe key, provenance and
    // every field this script does not name.
    ...plan.updates.map((u) => (batch: ReturnType<Firestore['batch']>) => {
      batch.update(db.collection(SLOTS_COLLECTION).doc(u.id), { ...u.update });
    }),
    ...plan.creates.map((row) => (batch: ReturnType<Firestore['batch']>) => {
      batch.create(db.collection(SLOTS_COLLECTION).doc(), { ...row });
    }),
  ];
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.projectId === null) args.projectId = process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  console.log(`Target: ${describeTarget(args, process.env)}`);
  resolveTarget(args, process.env);
  if (getApps().length === 0) initializeApp(args.projectId ? { projectId: args.projectId } : {});
  const db = getFirestore();
  const plan = await buildPlan(db);
  if (args.apply) await applyPlan(db, plan);
  for (const line of reportLines(plan.report, args.apply)) console.log(line);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
