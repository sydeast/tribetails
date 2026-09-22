/**
 * repairDuplicateVetClinicId.ts
 *
 * Folds duplicate `vetClinicId` rows in `families/{id}.customFields` down to
 * one, keeping the NEWEST.
 *
 * ── WHAT IS WRONG IN PRODUCTION ───────────────────────────────────────────
 *
 * Before #873 (PR #900), portal web's Save on the Tribe Profile screen built the
 * profile payload with
 *
 *     mergeReservedFields(baseProfileFields, vetClinicFields, PROFILE_RESERVED_KEYS)
 *
 * and `PROFILE_RESERVED_KEYS` did NOT contain `vetClinicId`. So the stored
 * `vetClinicId` row survived the filter and a second one was APPENDED beside it.
 * On the no-schema path that ran on every save, so a household's list grew by one
 * `vetClinicId` row per press of Save Changes. #900 stopped new duplicates and
 * folds a key it SENDS, but a stored duplicate only folds on a save that sends
 * that key: a household that never saves again keeps its duplicates forever, and
 * a household whose vet is cleared has them all deleted rather than folded.
 *
 * ── WHICH COPY IS THE NEWEST ──────────────────────────────────────────────
 *
 * The LAST one in the array. Each duplicating save appended the value the screen
 * held at that moment, so the rows read oldest-to-newest, and a household that
 * changed clinic between saves has the old id first and the current one last.
 * Portal web already reads it that way: TribeProfile.tsx seeds its `vetClinicId`
 * state through `Object.fromEntries(fields.map(f => [f.key, f.value]))`, where a
 * later entry overwrites an earlier one. So keeping the last copy is what the
 * household already sees, and keeping the first would silently move some
 * households back to a clinic they left.
 *
 * Nothing on the server reads this row (households are linked to a clinic by
 * `kinfolk.primaryVetClinicId`, which `archiveVetClinic` / `vetClinicsWrite`
 * use); portal Android does not read it at all. Web is the only reader.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ─────────────────────────────────────────
 *
 *   `customFields`   the same list with the duplicate `vetClinicId` rows removed.
 *                    The surviving row carries the LAST copy's label and value
 *                    and sits at the FIRST copy's position, which is how the
 *                    callables' own merge folds a duplicate
 *                    (functions/src/lib/customFieldsMerge.ts), so a later portal
 *                    save produces the same list this script leaves behind.
 *                    Every other row is untouched, in place.
 *
 * `updatedAt` is NOT bumped and no repair stamp is written. A repaired household
 * keeps the times it already had: the document's timestamps say when the
 * HOUSEHOLD last changed something, and a cleanup that moves them makes every
 * "when did this record last change" answer wrong afterwards. The update carries
 * exactly one key, never a `set()`, so nothing else can be altered by accident.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * Only a document that holds two or more `vetClinicId` rows is planned for a
 * write. After one run none does, so a second run plans nothing and commits no
 * batch.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 *
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --apply        writes, batched under Firestore's 500-op limit.
 *   --allow-prod   the target is PRODUCTION. Required to touch production at all,
 *                  and REFUSED when FIRESTORE_EMULATOR_HOST is set, because then
 *                  the flags and the environment disagree about where the writes
 *                  would go. The two flags are separate on purpose: --allow-prod
 *                  says WHERE, --apply says WHETHER TO WRITE, so a dry run
 *                  against production and a writing run against the emulator are
 *                  both sayable.
 *
 * The target is printed before anything is read.
 *
 * NOTHING PRIVATE IS PRINTED. Output is household ids, document paths, row keys
 * and counts. A clinic id is printed, because it is a catalog document id, never
 * a household secret; no other row's value is.
 *
 * Usage (the operator runs this against prod; an agent session does not):
 *
 *   npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project auntieos-ttpc --allow-prod
 *   npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project auntieos-ttpc --allow-prod --apply
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login), or
 * FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846).
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';

/** The duplicated key. One key, deliberately: this is a repair for one defect, not a generic de-duplicator. */
export const DUPLICATED_KEY = 'vetClinicId';

/** Firestore's write limit per batch. */
export const BATCH_LIMIT = 500;
const PAGE = 500;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  apply: boolean;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, apply: false, samples: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--project') args.projectId = value();
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--samples') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          `repairDuplicateVetClinicId.ts: folds duplicate ${DUPLICATED_KEY} rows in families/{id}.customFields, keeping the newest (#901)`,
          '',
          '  npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod',
          '  npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod --apply',
          '',
          'Dry run unless --apply. Prints ids, paths, row keys and counts only.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type Target = { kind: 'emulator'; host: string; projectId: string | null } | { kind: 'production'; projectId: string | null };

export function describeTarget(args: Args, env: Record<string, string | undefined>): string {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const project = args.projectId ?? '(default credentials project)';
  const mode = args.apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)';
  return host ? `EMULATOR at ${host}, project ${project} - ${mode}` : `PRODUCTION Firestore, project ${project} - ${mode}`;
}

/** Throws when the flags and the environment disagree about where the writes would go. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host && args.allowProd) {
    throw new Error(
      `--allow-prod refused: FIRESTORE_EMULATOR_HOST is set (${host}), so this would touch the emulator, not production. ` +
        'Unset FIRESTORE_EMULATOR_HOST to reach production, or drop --allow-prod to work against the emulator.',
    );
  }
  if (host) return { kind: 'emulator', host, projectId: args.projectId };
  if (!args.allowProd) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set, so this would reach PRODUCTION. Pass --allow-prod to confirm.');
  }
  return { kind: 'production', projectId: args.projectId };
}

/** A row as the callables write it. An entry that is not one is carried through verbatim. */
interface Row {
  key?: unknown;
}

function keyOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const key = (entry as Row).key;
  return typeof key === 'string' ? key : null;
}

export interface Plan {
  /** The list to write, or null when this document needs no write. */
  customFields: unknown[] | null;
  /** How many copies of the key were stored. */
  copies: number;
  /** The value kept, for the report. A clinic id is a catalog document id, not a secret. */
  kept: string | null;
  /** The values dropped, oldest first. */
  dropped: string[];
}

/**
 * The repaired list for one stored `customFields`, or `customFields: null` when
 * there is nothing to do.
 *
 * The surviving row is the LAST copy's row placed at the FIRST copy's index: the
 * same fold `mergeCustomFields` in functions/src/lib/customFieldsMerge.ts does
 * for a key a client sends, so a portal save after this repair produces the list
 * this repair already wrote. Rows with no readable key are carried through, as
 * the callables carry them: nothing here deletes what it cannot read.
 */
export function planRepair(stored: unknown): Plan {
  const list: unknown[] = Array.isArray(stored) ? stored : [];
  const copies = list.filter((entry) => keyOf(entry) === DUPLICATED_KEY);
  if (copies.length < 2) return { customFields: null, copies: copies.length, kept: null, dropped: [] };
  const newest = copies[copies.length - 1];
  const valueOf = (entry: unknown): string => {
    const v = (entry as { value?: unknown }).value;
    return typeof v === 'string' ? v : '';
  };
  let placed = false;
  const out: unknown[] = [];
  for (const entry of list) {
    if (keyOf(entry) !== DUPLICATED_KEY) {
      out.push(entry);
      continue;
    }
    if (placed) continue;
    out.push(newest);
    placed = true;
  }
  return {
    customFields: out,
    copies: copies.length,
    kept: valueOf(newest),
    dropped: copies.slice(0, -1).map(valueOf),
  };
}

export interface Finding {
  kinfolkId: string;
  path: string;
  copies: number;
  kept: string | null;
  dropped: string[];
  rowsBefore: number;
  rowsAfter: number;
}

export interface Report {
  scanned: number;
  findings: Finding[];
}

/** READS ONLY. Every document that holds two or more of the key, with the list each would be repaired to. */
export async function buildPlan(db: Firestore): Promise<{ report: Report; writes: Array<{ path: string; customFields: unknown[] }> }> {
  const report: Report = { scanned: 0, findings: [] };
  const writes: Array<{ path: string; customFields: unknown[] }> = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('families').orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      report.scanned += 1;
      const stored = (doc.data() as Record<string, unknown>)['customFields'];
      const plan = planRepair(stored);
      if (plan.customFields === null) continue;
      report.findings.push({
        kinfolkId: doc.id,
        path: doc.ref.path,
        copies: plan.copies,
        kept: plan.kept,
        dropped: plan.dropped,
        rowsBefore: Array.isArray(stored) ? stored.length : 0,
        rowsAfter: plan.customFields.length,
      });
      writes.push({ path: doc.ref.path, customFields: plan.customFields });
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
  report.findings.sort((a, b) => b.copies - a.copies || a.kinfolkId.localeCompare(b.kinfolkId));
  return { report, writes };
}

/**
 * Writes the planned lists, batched under Firestore's limit.
 *
 * `update` with ONE key, never `set`: `displayName`, `updatedAt`, the household's
 * own timestamps and everything else on the document are left exactly as they
 * are. A repaired household keeps its ORIGINAL times.
 */
export async function applyPlan(db: Firestore, writes: Array<{ path: string; customFields: unknown[] }>): Promise<number> {
  let written = 0;
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const chunk = writes.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const w of chunk) batch.update(db.doc(w.path), { customFields: w.customFields });
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

export function reportLines(report: Report, samples: number, applied: number | null): string[] {
  const lines: string[] = [];
  lines.push(`Duplicate ${DUPLICATED_KEY} rows in families/{id}.customFields (#901).`);
  lines.push(`Scanned ${report.scanned} household(s). ${report.findings.length} hold more than one ${DUPLICATED_KEY} row.`);
  const extraRows = report.findings.reduce((n, f) => n + (f.copies - 1), 0);
  lines.push(`Rows that would be removed: ${extraRows}.`);
  const changedClinic = report.findings.filter((f) => f.dropped.some((v) => v !== f.kept));
  lines.push(`Households whose copies disagree (the newest is not what the older ones say): ${changedClinic.length}.`);
  const shown = report.findings.slice(0, samples);
  if (shown.length > 0) {
    lines.push('');
    lines.push(`First ${shown.length} of ${report.findings.length}:`);
    for (const f of shown) {
      lines.push(`  ${f.path}  copies=${f.copies}  rows ${f.rowsBefore} -> ${f.rowsAfter}  keep=${f.kept}  drop=[${f.dropped.join(', ')}]`);
    }
  }
  lines.push('');
  lines.push(applied === null ? 'DRY RUN: nothing was written. Re-run with --apply to write.' : `APPLIED: ${applied} household(s) updated. updatedAt was NOT changed.`);
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.projectId === null) args.projectId = process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  console.log(`Target: ${describeTarget(args, process.env)}`);
  resolveTarget(args, process.env);
  if (getApps().length === 0) initializeApp(args.projectId ? { projectId: args.projectId } : {});
  const db = getFirestore();
  const { report, writes } = await buildPlan(db);
  const applied = args.apply ? await applyPlan(db, writes) : null;
  for (const line of reportLines(report, args.samples, applied)) console.log(line);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
