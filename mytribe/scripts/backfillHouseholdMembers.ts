/**
 * backfillHouseholdMembers.ts (#2096, after #1840)
 *
 * WHAT IT FIXES. Since #1840 a household notice goes only to a login that is
 * an ACTIVE member of `families/{id}/members`. Accepting an invite has always
 * written that record. The old admin "link login" (`setKinfolkClaim`, before
 * #2096) did not: it wrote `kinfolk/{id}.uid` and the claim and no member
 * record. `memberGate` and the rules treat such a login as the household's
 * primary ("legacy primary"), and `resolveKinfolkUid` keeps sending to it
 * until this runs, logging `notification.household.recipient.legacy_primary`
 * each time. This writes the ACTIVE PRIMARY record for each such login, in the
 * shape `acceptInvite` writes (`functions/src/lib/householdMember.ts`).
 *
 * WHICH HOUSEHOLDS. Every `kinfolk` record with a login stored on it, where
 * that login's own client record lists the household. The same decision
 * `setKinfolkClaim` and the test-login scripts make, per household:
 *   - already an ACTIVE member          -> nothing to do
 *   - staff login (#1840)               -> left alone, listed for you
 *   - removed member (record not ACTIVE)-> left alone, listed for you
 *   - household has another PRIMARY     -> left alone, listed for you
 *   - login on another household too    -> left alone, listed for you
 *   - no household record / no account  -> left alone, listed for you
 *   - client record does not list it    -> left alone, counted
 *   - otherwise                         -> writes the ACTIVE PRIMARY record
 *
 * SAFETY.
 *   - DRY RUN BY DEFAULT. Prints what it would do and writes nothing.
 *   - Reading production needs --allow-prod; writing needs --allow-prod AND
 *     --apply (on the emulators: FIRESTORE_EMULATOR_HOST +
 *     FIREBASE_AUTH_EMULATOR_HOST, and --apply).
 *   - Idempotent. Each record is written with `create`, so a record that
 *     exists is never overwritten, and a second run reports 0 to write.
 *   - Prints household ids and reasons only. Never a login id, an email or a
 *     name.
 *
 * Operator commands (from the repo root):
 *   npm --prefix mytribe/functions run backfill:household-members -- --project auntieos-ttpc --allow-prod
 *   npm --prefix mytribe/functions run backfill:household-members -- --project auntieos-ttpc --allow-prod --apply
 */

import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getApps, initializeApp, applicationDefault, getFirestore, getAuth, FieldValue } from './lib/firebaseAdmin';
import { planPrimaryLink, writePrimaryMember, type PrimaryLinkPlan } from './lib/householdPrimary';
import type { PrimaryLinkRefusal } from '../functions/src/lib/householdMember';

export const PRODUCTION_PROJECT_ID = 'auntieos-ttpc';
const PAGE = 300;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
export interface Args {
  apply: boolean;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, allowProd: false, projectId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') args.apply = true;
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a.startsWith('--project=')) {
      const v = a.slice('--project='.length);
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillHouseholdMembers.ts - write the member record for logins linked before the member model (#2096)',
          '',
          '  npm --prefix mytribe/functions run backfill:household-members -- --project auntieos-ttpc --allow-prod          # DRY RUN',
          '  npm --prefix mytribe/functions run backfill:household-members -- --project auntieos-ttpc --allow-prod --apply  # write',
          '',
          'Writes only with BOTH --allow-prod and --apply (or --apply on the emulators).',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type RunMode = 'dry-run' | 'apply';

/**
 * Which mode the run is in, or a refusal. Production (or any real project)
 * needs --allow-prod even to read; a write needs --apply on top. The
 * emulators need no --allow-prod.
 */
export function resolveMode(args: Args, env: { emulator: boolean }): RunMode {
  if (!env.emulator && !args.allowProd) {
    throw new Error('refusing to read a real project without --allow-prod (or the emulators)');
  }
  return args.apply ? 'apply' : 'dry-run';
}

// ---------------------------------------------------------------------------
// Per-household outcome. PURE.
// ---------------------------------------------------------------------------
export type Outcome =
  | { kind: 'write' }
  | { kind: 'already_member' }
  | { kind: 'not_listed' }
  | { kind: 'refused'; why: PrimaryLinkRefusal };

export function classify(plan: PrimaryLinkPlan): Outcome {
  const d = plan.decision;
  if (d.action === 'none') return { kind: 'already_member' };
  if (d.action === 'refuse') return { kind: 'refused', why: d.why };
  if (!plan.facts.listedOnHousehold) return { kind: 'not_listed' };
  return { kind: 'write' };
}

export interface Row {
  familyId: string;
  uid: string;
  plan: PrimaryLinkPlan;
  outcome: Outcome;
}

export interface Summary {
  scanned: number;
  withLogin: number;
  write: number;
  alreadyMember: number;
  notListed: number;
  refused: Partial<Record<PrimaryLinkRefusal, number>>;
}

export function summarize(scanned: number, rows: readonly Row[]): Summary {
  const s: Summary = { scanned, withLogin: rows.length, write: 0, alreadyMember: 0, notListed: 0, refused: {} };
  for (const r of rows) {
    const o = r.outcome;
    if (o.kind === 'write') s.write += 1;
    else if (o.kind === 'already_member') s.alreadyMember += 1;
    else if (o.kind === 'not_listed') s.notListed += 1;
    else s.refused[o.why] = (s.refused[o.why] ?? 0) + 1;
  }
  return s;
}

/** The lines the operator reads. Household ids and reasons only: no login id, email or name. */
export function reportLines(summary: Summary, rows: readonly Row[], mode: RunMode): string[] {
  const out: string[] = [];
  out.push(`backfillHouseholdMembers  mode=${mode}`);
  out.push(`households scanned: ${summary.scanned}`);
  out.push(`with a login stored: ${summary.withLogin}`);
  out.push(`  already an ACTIVE member: ${summary.alreadyMember}`);
  out.push(`  login's client record does not list the household (left alone): ${summary.notListed}`);
  out.push(`  ${mode === 'apply' ? 'to write' : 'would write'} ACTIVE PRIMARY record: ${summary.write}`);
  for (const [why, n] of Object.entries(summary.refused)) out.push(`  left alone, ${why}: ${n}`);
  const writes = rows.filter((r) => r.outcome.kind === 'write');
  if (writes.length > 0) {
    out.push('');
    out.push(mode === 'apply' ? 'Writing for these households:' : 'Would write for these households:');
    for (const r of writes) out.push(`  ${r.familyId}`);
  }
  const refused = rows.filter((r) => r.outcome.kind === 'refused');
  if (refused.length > 0) {
    out.push('');
    out.push('Left alone, for you to look at (Directory, the household, Members and invites):');
    for (const r of refused) out.push(`  ${r.familyId}  ${(r.outcome as { why: string }).why}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O. Handles injected so tests drive it with fakes or the emulators.
// ---------------------------------------------------------------------------
export async function buildRows(deps: { db: Firestore; auth: Auth }): Promise<{ scanned: number; rows: Row[] }> {
  const rows: Row[] = [];
  let scanned = 0;
  let last: string | null = null;
  for (;;) {
    let q = deps.db.collection('kinfolk').orderBy('__name__').limit(PAGE);
    if (last !== null) q = q.startAfter(last);
    const page = await q.get();
    for (const d of page.docs) {
      scanned += 1;
      const uid = (d.data() as { uid?: unknown }).uid;
      if (typeof uid !== 'string' || uid.trim() === '') continue;
      const plan = await planPrimaryLink(deps, d.id, uid);
      rows.push({ familyId: d.id, uid, plan, outcome: classify(plan) });
    }
    if (page.docs.length < PAGE) break;
    last = page.docs[page.docs.length - 1]!.id;
  }
  return { scanned, rows };
}

export interface ApplyResult {
  written: number;
  alreadyThere: number;
}

/** Writes each `write` row with `create`. A record that appeared since the scan is counted, never overwritten. */
export async function applyRows(db: Firestore, rows: readonly Row[], stamp: unknown): Promise<ApplyResult> {
  const res: ApplyResult = { written: 0, alreadyThere: 0 };
  for (const r of rows) {
    if (r.outcome.kind !== 'write') continue;
    try {
      await writePrimaryMember(db, r.familyId, r.uid, r.plan, stamp, { createdBy: 'backfillHouseholdMembers' });
      res.written += 1;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 6 || code === 'already-exists') {
        res.alreadyThere += 1;
        continue;
      }
      throw err;
    }
  }
  return res;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = Boolean(process.env['FIRESTORE_EMULATOR_HOST'] && process.env['FIREBASE_AUTH_EMULATOR_HOST']);
  const mode = resolveMode(args, { emulator });
  if (!emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set (and the emulators are not). Refusing to fall back silently.');
  }
  const projectId = args.projectId ?? process.env['GCLOUD_PROJECT'] ?? PRODUCTION_PROJECT_ID;
  if (getApps().length === 0) {
    initializeApp(emulator ? { projectId } : { credential: applicationDefault(), projectId });
  }
  const deps = { db: getFirestore(), auth: getAuth() };
  console.log(`project=${projectId}  target=${emulator ? 'EMULATOR' : projectId === PRODUCTION_PROJECT_ID ? 'PRODUCTION' : 'REAL PROJECT'}`);

  const { scanned, rows } = await buildRows(deps);
  const summary = summarize(scanned, rows);
  for (const line of reportLines(summary, rows, mode)) console.log(line);

  if (mode === 'dry-run') {
    console.log('\nDRY RUN: nothing was written. Re-run with --apply (and --allow-prod) to write.');
    return;
  }
  const applied = await applyRows(deps.db, rows, FieldValue.serverTimestamp());
  console.log(`\nAPPLIED: ${applied.written} member record(s) written; ${applied.alreadyThere} already there.`);
  console.log('Re-run without --apply to confirm it now reports 0 to write.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
