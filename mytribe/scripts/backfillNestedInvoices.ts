/**
 * backfillNestedInvoices.ts
 *
 * One-off Firestore backfill that retires a PHANTOM nested invoice path.
 *
 * Three MyTribe functions historically targeted `families/{id}/invoices/{id}`,
 * but nothing ever wrote there — AuntieOS Android + web (and the MyTribe
 * portal callables) all read/write the FLAT top-level `invoices` collection,
 * where each doc carries its own `kinfolkId`. Task #12 repointed those
 * functions at the flat collection. This script closes the loop by copying any
 * stray nested doc up to `invoices/{id}` (stamping `kinfolkId`) and then, only
 * with --allow-prod, deleting the nested original.
 *
 * In practice the nested collection is empty in prod, so this should report
 * scanned=0 and no-op safely.
 *
 * Modes:
 *   default        — dry-run, prints planned changes to stdout, no writes
 *   --allow-prod   — performs writes (copy-up) AND deletes nested originals
 *
 * Safety:
 *   - Dry-run by default; refuses to write unless `--allow-prod` is passed. An
 *     explicit `--dry-run` beats `--allow-prod` in either flag order.
 *     FIRESTORE_EMULATOR_HOST does NOT relieve that: it only stands in for
 *     credentials, so an emulator run without --allow-prod is still a dry run
 *     that writes nothing, to the emulator or anywhere else.
 *   - When writing to prod, requires GOOGLE_APPLICATION_CREDENTIALS (fail-loud).
 *   - Copy-up is merge:true on the SAME deterministic id, so re-running is
 *     idempotent and never clobbers a richer flat doc that AuntieOS already
 *     owns (only fills `kinfolkId` + carried fields).
 *   - Never overwrites an existing flat `kinfolkId` with a different value;
 *     a mismatch is reported and skipped (fail-safe, no silent reassignment).
 *   - Deletes happen ONLY after a successful copy and ONLY with --allow-prod.
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

type Mode = 'dry-run' | 'apply';

interface Args {
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
  // is safe before it copies invoices up and DELETES the nested originals;
  // getting its precedence backwards defeats that purpose.
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
          'backfillNestedInvoices.ts — copy stray nested invoices up to the flat collection',
          '',
          'Usage:',
          '  ts-node backfillNestedInvoices.ts                # dry-run (default)',
          '  ts-node backfillNestedInvoices.ts --allow-prod   # copy-up + delete nested',
          '  ts-node backfillNestedInvoices.ts --dry-run      # force dry-run, ALWAYS wins',
          '  ts-node backfillNestedInvoices.ts --project <id> # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
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

/** A single planned copy-up, derived purely from inputs (deterministic + testable). */
export interface CopyPlan {
  invoiceId: string;
  kinfolkId: string;
  nestedPath: string;
  data: Record<string, unknown>;
}

export type PlanDecision =
  | { action: 'copy'; plan: CopyPlan }
  | { action: 'skip'; reason: string; invoiceId: string };

/**
 * Decides what to do with one nested invoice doc given the current flat doc
 * (if any). Pure: no Firestore access, so it is unit-testable.
 *
 * @param nestedFamilyId the `{familyId}` path segment of the nested doc
 * @param invoiceId      the nested doc id (also the flat target id)
 * @param nestedData     the nested doc payload
 * @param flatData       the existing flat `invoices/{invoiceId}` payload, or null
 */
export function planCopy(
  nestedFamilyId: string,
  invoiceId: string,
  nestedData: Record<string, unknown>,
  flatData: Record<string, unknown> | null,
): PlanDecision {
  const nestedPath = `families/${nestedFamilyId}/invoices/${invoiceId}`;
  if (!nestedFamilyId) {
    return { action: 'skip', reason: 'no_family_segment', invoiceId };
  }
  // The flat doc carries its own kinfolkId; prefer the nested doc's own value
  // if present, else fall back to the path segment.
  const nestedKinfolkId =
    typeof nestedData.kinfolkId === 'string' && nestedData.kinfolkId.trim()
      ? nestedData.kinfolkId.trim()
      : nestedFamilyId;

  if (flatData) {
    const flatKinfolkId =
      typeof flatData.kinfolkId === 'string' ? flatData.kinfolkId.trim() : '';
    if (flatKinfolkId && flatKinfolkId !== nestedKinfolkId) {
      return { action: 'skip', reason: 'flat_kinfolkId_mismatch', invoiceId };
    }
  }

  return {
    action: 'copy',
    plan: {
      invoiceId,
      kinfolkId: nestedKinfolkId,
      nestedPath,
      // merge:true at write time; stamp kinfolkId so the portal can see it.
      data: { ...nestedData, kinfolkId: nestedKinfolkId },
    },
  };
}

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillNestedInvoices: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (!getApps().length) initializeApp({ projectId });
}

interface RunResult {
  scanned: number;
  copied: number;
  deleted: number;
  skipped: Record<string, number>;
}

function bumpSkip(r: RunResult, reason: string): void {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + 1;
}

async function run(mode: Mode): Promise<RunResult> {
  const db = getFirestore();
  const result: RunResult = { scanned: 0, copied: 0, deleted: 0, skipped: {} };

  // collectionGroup('invoices') matches BOTH flat `invoices/*` and nested
  // `families/*/invoices/*`. We only act on the nested ones — detected by a
  // parent path of `families/{id}/invoices`.
  const snap = await db.collectionGroup('invoices').get();

  for (const docSnap of snap.docs) {
    const parentPath = docSnap.ref.parent.path; // e.g. "families/3/invoices" or "invoices"
    const segments = parentPath.split('/');
    const isNested = segments.length === 3 && segments[0] === 'families' && segments[2] === 'invoices';
    if (!isNested) continue; // flat doc — leave it alone

    result.scanned += 1;
    const familyId = segments[1];
    const invoiceId = docSnap.id;
    const nestedData = docSnap.data() as Record<string, unknown>;

    const flatRef = db.collection('invoices').doc(invoiceId);
    const flatSnap = await flatRef.get();
    const flatData = flatSnap.exists ? (flatSnap.data() as Record<string, unknown>) : null;

    const decision = planCopy(familyId, invoiceId, nestedData, flatData);
    if (decision.action === 'skip') {
      bumpSkip(result, decision.reason);
      console.log(`[skip:${decision.reason}] ${decision.invoiceId} (${docSnap.ref.path})`);
      continue;
    }

    console.log(
      `[copy] ${decision.plan.nestedPath} -> invoices/${decision.plan.invoiceId} (kinfolkId=${decision.plan.kinfolkId})`,
    );
    if (mode === 'apply') {
      await flatRef.set(decision.plan.data, { merge: true });
      result.copied += 1;
      // Delete the nested original only after a successful copy-up.
      await docSnap.ref.delete();
      result.deleted += 1;
      console.log(`[delete] ${docSnap.ref.path}`);
    }
  }

  return result;
}

function summarise(r: RunResult): void {
  console.log('\n=== backfillNestedInvoices ===');
  console.log(`  scanned : ${r.scanned}`);
  console.log(`  copied  : ${r.copied}`);
  console.log(`  deleted : ${r.deleted}`);
  console.log(`  skipped :`);
  for (const [reason, n] of Object.entries(r.skipped)) {
    console.log(`    ${reason}: ${n}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  if (args.mode === 'apply' && !args.allowProd && !usingEmulator) {
    throw new Error(
      'backfillNestedInvoices: refusing to write — pass --allow-prod or set FIRESTORE_EMULATOR_HOST',
    );
  }

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);

  const result = await run(args.mode);
  summarise(result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_NESTED_INVOICES',
      description: `copied=${result.copied} deleted=${result.deleted} scanned=${result.scanned}`,
      status: 'SUCCESS',
      actorId: 'system:backfillNestedInvoices',
      targetId: '',
      targetCollection: 'invoices',
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result },
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
